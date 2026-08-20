// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * QuorumVaultV3 — the self-driving vault. No keeper, no server, no executor
 * key custodying anything: the vault holds its own collateral and outcome
 * tokens, places its own IOC orders on the dreamDEX pools, redeems its own
 * winnings from the settlement singleton, and settles its own epochs. The only
 * thing that ever touches the pot is this contract.
 *
 * What drives it: `runEpoch()` is PERMISSIONLESS — a QuorumBrain reactivity
 * callback calls it every window boundary once armed, but any EOA can call it
 * too, so the vault works from day one and a dropped callback is healable by
 * anyone. The brain also feeds `noteWindow` from the venue's own MarketCreated
 * events, so market discovery is chain-fed, not operator-fed.
 *
 * The share-pricing law is unchanged from v2 and is the whole point: shares
 * price ONLY at flat moments — everything in plain collateral here — so the
 * price is `balance / supply`, an on-chain fact. Mid-epoch deposits and
 * withdrawals queue for the next settle's single snapshot.
 *
 * Money policy, on-chain now: each epoch stakes STAKE_BP of the pot, split so
 * every live window gets the SAME number of contracts (budget per window is
 * proportional to its price — equal cash would be a leveraged bet on whichever
 * market is cheapest). Never all-in: BTC and ETH agree most windows, and an
 * all-in pot multiplies by ~0 every time the whole bucket loses.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/** The Shannon test collateral mints to any caller — contracts included. */
interface IFaucet {
    function faucet(uint256 amount) external;
}

interface IBinaryPool {
    struct Level {
        uint256 price;
        uint256 quantity;
    }
    struct BookParams {
        uint256 tickSize;
        uint256 minQuantity;
        uint256 lotSize;
    }
    /// kind: 0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO. price is YES terms.
    /// orderType: 0 limit, 1 FOK, 2 IOC (market), 3 post-only.
    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external returns (bool fullyFilled, uint128 orderId);
    function getBookLevels(bool isBid, uint64 numLevels) external view returns (Level[] memory);
    function getOrderBookParameters() external view returns (BookParams memory);
}

/**
 * The registry and settler. Everything here is keyed by marketId — the ONLY
 * identity that survives a window: this venue recycles both the pool and the
 * market shell onto the next window within minutes of expiry, so any address
 * the vault stored is already answering for a different market by the time
 * redemption comes around. (The first cut of this contract asked the stored
 * market address `isResolved()` and got the NEXT window's honest "false".)
 */
interface IBinaryModule {
    function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount) external;
}

interface IERC6909 {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function setOperator(address spender, bool approved) external returns (bool);
}

contract QuorumVaultV3 {
    // ------------------------------------------------------------- ERC-20
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // -------------------------------------------------------------- vault
    IERC20 public immutable asset;
    IBinaryModule public immutable module;
    IERC6909 public immutable outcomeToken;
    bool public immutable isUp;
    address public owner;
    /** The reactivity hub allowed to feed windows. runEpoch stays public. */
    address public brain;

    enum Phase {
        OPEN,
        DEPLOYED
    }
    Phase public phase;
    uint64 public epoch;
    uint256 public lastSettlePrice;

    struct Pending {
        address account;
        uint128 amount;
    }
    Pending[] public pendingDeposits;
    Pending[] public pendingWithdraws;
    uint256 public pendingDepositAssets;
    uint256 public pendingWithdrawShares;

    struct Window {
        bytes32 marketId;
        address market;
        address pool;
        uint256 yesId;
        uint256 noId;
        uint64 tradingStart;
        uint64 expiry;
        bool entered;
    }
    Window[] public windows;

    uint256 public constant QUEUE_CAP = 64;
    uint256 public constant WINDOW_CAP = 8;
    /** Stake per epoch, basis points of the pot. See the header for why not 100%. */
    uint256 public constant STAKE_BP = 3_333;
    /** Skip windows without at least this long left: an entry needs time to matter. */
    uint256 public constant MIN_HEADROOM = 120;
    /** After this long past expiry with no resolution, give up waiting and settle without it. */
    uint256 public constant RESOLUTION_GRACE = 2 hours;
    uint256 private constant VIRTUAL = 1e6;
    uint256 private constant PRICE_ONE = 1e18;
    uint256 private constant ONE = 1e6; // collateral scale

    event InstantDeposit(address indexed account, uint256 assets, uint256 shares);
    event InstantWithdraw(address indexed account, uint256 shares, uint256 assets);
    event DepositRequested(address indexed account, uint64 indexed epoch_, uint256 assets);
    event WithdrawRequested(address indexed account, uint64 indexed epoch_, uint256 shares);
    event WindowNoted(bytes32 indexed marketId, address indexed pool, uint64 expiry);
    event WindowEntered(bytes32 indexed marketId, uint256 quantity, uint256 yesLimit);
    event EntrySkipped(bytes32 indexed marketId, bytes reason);
    event WindowRedeemed(bytes32 indexed marketId, uint256 paid);
    event EpochSettled(uint64 indexed epoch_, uint256 price, uint256 cash, uint256 supply);

    error NotOwner();
    error NotBrain();
    error ZeroAmount();
    error QueueFull();

    constructor(IERC20 asset_, IBinaryModule module_, IERC6909 outcomeToken_, bool isUp_, string memory name_, string memory symbol_) {
        asset = asset_;
        module = module_;
        outcomeToken = outcomeToken_;
        isUp = isUp_;
        owner = msg.sender;
        // The module burns our outcome tokens when we redeem through it.
        outcomeToken.setOperator(address(module_), true);
    }

    function setBrain(address brain_) external {
        if (msg.sender != owner) revert NotOwner();
        brain = brain_;
    }

    // ------------------------------------------------------------- views

    function cash() public view returns (uint256) {
        return asset.balanceOf(address(this)) - pendingDepositAssets;
    }

    function openPrice() public view returns (uint256) {
        return ((cash() + VIRTUAL) * PRICE_ONE) / (totalSupply + VIRTUAL);
    }

    function queueLengths() external view returns (uint256 deposits, uint256 withdraws) {
        return (pendingDeposits.length, pendingWithdraws.length);
    }

    function windowCount() external view returns (uint256) {
        return windows.length;
    }

    /** Everything the UI needs about the bucket, one call. */
    function windowsView()
        external
        view
        returns (Window[] memory list, uint256[] memory held)
    {
        list = windows;
        held = new uint256[](windows.length);
        for (uint256 i = 0; i < windows.length; i++) {
            held[i] = outcomeToken.balanceOf(
                address(this),
                isUp ? windows[i].yesId : windows[i].noId
            );
        }
    }

    // ----------------------------------------------------- holder actions

    /** Deposit your own collateral. Requires a one-time ERC-20 approval. */
    function deposit(uint256 assets) external {
        if (assets == 0) revert ZeroAmount();
        if (!asset.transferFrom(msg.sender, address(this), assets)) revert();
        _credit(msg.sender, assets);
    }

    /** One transaction, no approval: the vault faucet-mints its own collateral. */
    function depositFree(uint256 assets) external {
        if (assets == 0 || assets > 100_000e6) revert ZeroAmount();
        IFaucet(address(asset)).faucet(assets);
        _credit(msg.sender, assets);
    }

    /** Leave. Instant at the flat price, or queued for the next settle. */
    function exit(uint256 shares) external {
        if (shares == 0) revert ZeroAmount();
        if (phase == Phase.OPEN) {
            uint256 assets = (shares * (cash() + VIRTUAL)) / (totalSupply + VIRTUAL);
            _burn(msg.sender, shares);
            if (!asset.transfer(msg.sender, assets)) revert();
            emit InstantWithdraw(msg.sender, shares, assets);
        } else {
            if (pendingWithdraws.length >= QUEUE_CAP) revert QueueFull();
            _transfer(msg.sender, address(this), shares);
            pendingWithdraws.push(Pending(msg.sender, uint128(shares)));
            pendingWithdrawShares += shares;
            emit WithdrawRequested(msg.sender, epoch, shares);
        }
    }

    function _credit(address account, uint256 assets) internal {
        if (phase == Phase.OPEN) {
            uint256 shares = (assets * (totalSupply + VIRTUAL)) / (cash() - assets + VIRTUAL);
            if (shares == 0) revert ZeroAmount();
            _mint(account, shares);
            emit InstantDeposit(account, assets, shares);
        } else {
            if (pendingDeposits.length >= QUEUE_CAP) revert QueueFull();
            pendingDeposits.push(Pending(account, uint128(assets)));
            pendingDepositAssets += assets;
            emit DepositRequested(account, epoch, assets);
        }
    }

    // ------------------------------------------------------ the epoch loop

    /**
     * Chain-fed market discovery: the brain forwards the venue's MarketCreated
     * events. Everything here is defensive because the data crosses a contract
     * boundary — wrong collateral, stale expiry, or a full list simply drop it.
     */
    function noteWindow(
        bytes32 marketId,
        address market,
        address pool,
        uint256 yesId,
        uint256 noId,
        uint64 tradingStart,
        uint64 expiry
    ) external {
        if (msg.sender != brain && msg.sender != owner) revert NotBrain();
        if (expiry <= block.timestamp + MIN_HEADROOM) return;
        _prune();
        if (windows.length >= WINDOW_CAP) return;
        for (uint256 i = 0; i < windows.length; i++) {
            if (windows[i].marketId == marketId) return;
        }
        windows.push(Window(marketId, market, pool, yesId, noId, tradingStart, expiry, false));
        emit WindowNoted(marketId, pool, expiry);
    }

    /**
     * One pass of the machine, callable by anyone at any time:
     * redeem what resolved -> if flat again, settle the epoch -> enter what is
     * live. Each stage guards itself, so calling this too often is merely gas.
     */
    function runEpoch() external {
        _redeemResolved();
        _maybeSettle();
        _maybeEnter();
    }

    function _redeemResolved() internal {
        for (uint256 i = 0; i < windows.length; i++) {
            Window storage w = windows[i];
            if (!w.entered) continue;
            if (block.timestamp <= w.expiry) continue; // still trading

            // Redemption is the readiness check: the module reverts while the
            // market is unresolved and pays (possibly zero, for the losing
            // side) once it is. Asking any stored ADDRESS is wrong by now —
            // see IBinaryModule's header — so marketId does all the talking.
            uint256 before = asset.balanceOf(address(this));
            bool done = _redeemSide(w.marketId, isUp ? 0 : 1, isUp ? w.yesId : w.noId);
            if (!done && block.timestamp < uint256(w.expiry) + RESOLUTION_GRACE) continue;
            if (done) {
                // A voided market pays the other side too; claim it if held.
                _redeemSide(w.marketId, isUp ? 1 : 0, isUp ? w.noId : w.yesId);
            }
            // Past grace with no resolution: abandon rather than freeze the
            // vault; the tokens stay held and a later pass can still claim.
            w.entered = false;
            emit WindowRedeemed(w.marketId, asset.balanceOf(address(this)) - before);
        }
    }

    function _redeemSide(bytes32 marketId, uint8 outcomeIdx, uint256 id) internal returns (bool) {
        uint256 held = outcomeToken.balanceOf(address(this), id);
        if (held == 0) return true; // nothing to claim is a settled state
        try module.redeem(0, bytes32(0), marketId, outcomeIdx, held) {
            return true;
        } catch {
            return false;
        }
    }

    /** Flat again after being deployed -> one snapshot price pays every queue. */
    function _maybeSettle() internal {
        if (phase != Phase.DEPLOYED) return;
        for (uint256 i = 0; i < windows.length; i++) {
            if (windows[i].entered) return; // still working
        }

        uint256 pot = cash();
        uint256 price = ((pot + VIRTUAL) * PRICE_ONE) / (totalSupply + VIRTUAL);

        for (uint256 i = 0; i < pendingWithdraws.length; i++) {
            Pending memory request = pendingWithdraws[i];
            uint256 assets = (uint256(request.amount) * price) / PRICE_ONE;
            _burn(address(this), request.amount);
            if (!asset.transfer(request.account, assets)) revert();
            emit InstantWithdraw(request.account, request.amount, assets);
        }
        delete pendingWithdraws;
        pendingWithdrawShares = 0;

        for (uint256 i = 0; i < pendingDeposits.length; i++) {
            Pending memory request = pendingDeposits[i];
            uint256 shares = (uint256(request.amount) * PRICE_ONE) / price;
            pendingDepositAssets -= request.amount;
            _mint(request.account, shares);
            emit InstantDeposit(request.account, request.amount, shares);
        }
        delete pendingDeposits;

        lastSettlePrice = price;
        phase = Phase.OPEN;
        epoch += 1;
        emit EpochSettled(epoch, price, pot, totalSupply);
    }

    /** Enter every live, unentered window with the same contract count each. */
    function _maybeEnter() internal {
        if (phase != Phase.OPEN) return;
        _prune();

        // First pass: which windows are live, and what does our side cost?
        uint256 liveCount;
        uint256[] memory asks = new uint256[](windows.length);
        for (uint256 i = 0; i < windows.length; i++) {
            Window storage w = windows[i];
            if (w.entered) continue;
            if (block.timestamp < w.tradingStart || block.timestamp + MIN_HEADROOM >= w.expiry) continue;
            uint256 ask = _ownAsk(w.pool);
            if (ask == 0 || ask >= ONE) continue;
            asks[i] = ask;
            liveCount++;
        }
        if (liveCount == 0) return;

        uint256 stake = (cash() * STAKE_BP) / 10_000;
        if (stake < ONE) return;

        // Equal contracts: the shared count is stake / sum(protective prices).
        uint256 protectiveSum;
        for (uint256 i = 0; i < windows.length; i++) {
            if (asks[i] != 0) protectiveSum += _protective(asks[i]);
        }
        if (protectiveSum == 0) return;
        uint256 contractsE6 = (stake * ONE) / protectiveSum;

        bool enteredAny;
        for (uint256 i = 0; i < windows.length; i++) {
            if (asks[i] == 0) continue;
            Window storage w = windows[i];
            uint256 protective = _protective(asks[i]);
            IBinaryPool.BookParams memory params = IBinaryPool(w.pool).getOrderBookParameters();
            uint256 quantity = (contractsE6 / params.lotSize) * params.lotSize;
            if (quantity < params.minQuantity || quantity == 0) continue;
            // YES-terms limit: our side's protective price, complemented for Down.
            uint256 yesLimit = isUp ? protective : ONE - protective;
            yesLimit = (yesLimit / params.tickSize) * params.tickSize;
            if (yesLimit == 0) yesLimit = params.tickSize;

            _ensureAllowance(w.pool);
            // The pool enforces 0 < expireNs <= the market's own expiry, so an
            // order lifetime must never be quoted past the window's close.
            uint256 orderExpiry = block.timestamp + 300;
            if (orderExpiry > w.expiry) orderExpiry = w.expiry;
            try
                IBinaryPool(w.pool).placeBinaryOrder(
                    isUp ? 0 : 2, // BUY_YES / BUY_NO
                    yesLimit,
                    quantity,
                    uint64(orderExpiry * 1e9),
                    2, // IOC: fill what crosses, refund the rest — nothing rests
                    0,
                    address(0),
                    0,
                    uint64(epoch)
                )
            {
                w.entered = true;
                enteredAny = true;
                emit WindowEntered(w.marketId, quantity, yesLimit);
            } catch (bytes memory reason) {
                // A hostile or empty book on one market must not stop the rest —
                // but the reason must not vanish either.
                emit EntrySkipped(w.marketId, reason);
            }
        }
        if (enteredAny) phase = Phase.DEPLOYED;
    }

    /** Top of our side's ask, in OUR side's terms (Down asks are 1 - yes bid). */
    function _ownAsk(address pool) internal view returns (uint256) {
        if (isUp) {
            IBinaryPool.Level[] memory asks = IBinaryPool(pool).getBookLevels(false, 1);
            return asks.length == 0 ? 0 : asks[0].price;
        }
        IBinaryPool.Level[] memory bids = IBinaryPool(pool).getBookLevels(true, 1);
        return bids.length == 0 ? 0 : ONE - bids[0].price;
    }

    /** The IOC's worst acceptable price: ask plus ~3% plus a 10-tick floor. */
    function _protective(uint256 ask) internal pure returns (uint256) {
        uint256 cushioned = ask + ask / 33 + 10_000; // ticks are 1e3 on this venue
        return cushioned >= ONE ? ONE - 1_000 : cushioned;
    }

    function _ensureAllowance(address pool) internal {
        if (asset.allowance(address(this), pool) < 1e12) {
            asset.approve(pool, type(uint256).max);
        }
    }

    function _prune() internal {
        uint256 i;
        while (i < windows.length) {
            Window storage w = windows[i];
            bool dead = !w.entered && block.timestamp + MIN_HEADROOM >= w.expiry;
            if (dead) {
                windows[i] = windows[windows.length - 1];
                windows.pop();
            } else {
                i++;
            }
        }
    }

    // ------------------------------------------------------------ innards

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) internal {
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }
}
