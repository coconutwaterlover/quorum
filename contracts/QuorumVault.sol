// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * QuorumVault — the shared UP / DOWN index vault (QUP / QDWN).
 *
 * One contract, deployed twice: the UP vault buys the Up side of every live
 * event-contract window on dreamDEX, the DOWN vault buys the Down side. Holders
 * own ERC-20 shares of a pot that rolls window after window.
 *
 * The share-pricing rule is the whole design, so it is stated up front: a share
 * is NEVER priced off a posted NAV, an oracle, or a mark of open positions.
 * It is priced only at moments when the vault is FLAT — everything in plain
 * collateral sitting at this address — so the price is `balance / supply`, an
 * on-chain fact anyone can check in the explorer. That closes the classic
 * attack on prediction-market vaults (depress a thin book's mark just before
 * depositing, mint cheap shares, let it resolve) by never having a mark to
 * depress.
 *
 * The epoch loop:
 *
 *   OPEN      all funds are collateral in the vault. Deposits and withdrawals
 *             execute instantly at the exact balance-based price.
 *   DEPLOYED  the operator has taken the cash to buy this side of every live
 *             window. Deposits and withdrawals queue; queued deposit cash
 *             stays in the vault (it is priced at settle, so it is never at
 *             risk before it is priced).
 *   settle    the operator returns all proceeds, and one snapshot price —
 *             again just `cash / supply` — pays every queued withdrawal and
 *             mints every queued deposit. Then the vault is OPEN again.
 *
 * Trust boundary, stated plainly: the operator custodies the cash while
 * DEPLOYED and is trusted to return it. Share pricing is trustless; execution
 * is not. This is a testnet demonstration, not a custody design.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/** The Shannon test collateral mints to any caller — contracts included. */
interface IFaucet {
    function faucet(uint256 amount) external;
}

contract QuorumVault {
    // ------------------------------------------------------------- ERC-20
    string public name;
    string public symbol;
    // Shares carry the collateral's 6 decimals so 1 share starts worth 1 tUSDC.
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // -------------------------------------------------------------- vault
    IERC20 public immutable asset;
    /** True for QUP, false for QDWN. Informational; the operator enforces it. */
    bool public immutable isUp;
    address public owner;
    address public operator;

    enum Phase {
        OPEN,
        DEPLOYED
    }
    Phase public phase;
    uint64 public epoch;
    /** Price of the last settle, 1e18-scaled collateral per share. 0 until the first. */
    uint256 public lastSettlePrice;

    struct Pending {
        address account;
        uint128 amount; // assets for deposits, shares for withdrawals
    }
    Pending[] public pendingDeposits;
    Pending[] public pendingWithdraws;
    /** Queued deposit collateral held here but NOT part of the priced pot. */
    uint256 public pendingDepositAssets;
    uint256 public pendingWithdrawShares;

    /** Queue cap so settleEpoch can never be gas-bombed past a block. */
    uint256 public constant QUEUE_CAP = 64;
    /**
     * Virtual liquidity folded into every price (the OZ decimal-offset trick):
     * makes the first-depositor donation-inflation attack cost more than it
     * can ever recover, without changing prices measurably at demo scale.
     */
    uint256 private constant VIRTUAL = 1e6;
    uint256 private constant PRICE_ONE = 1e18;

    event InstantDeposit(address indexed account, uint256 assets, uint256 shares);
    event InstantWithdraw(address indexed account, uint256 shares, uint256 assets);
    event DepositRequested(address indexed account, uint64 indexed epoch_, uint256 assets);
    event WithdrawRequested(address indexed account, uint64 indexed epoch_, uint256 shares);
    event FundsDeployed(uint64 indexed epoch_, uint256 assets);
    event EpochSettled(uint64 indexed epoch_, uint256 price, uint256 cash, uint256 supply);

    error NotOperator();
    error NotOwner();
    error WrongPhase();
    error ZeroAmount();
    error QueueFull();
    error NothingToDeploy();

    constructor(IERC20 asset_, bool isUp_, address operator_, string memory name_, string memory symbol_) {
        asset = asset_;
        isUp = isUp_;
        owner = msg.sender;
        operator = operator_;
        name = name_;
        symbol = symbol_;
    }

    // ------------------------------------------------------------- views

    /** Collateral in the priced pot (queued deposits excluded). */
    function cash() public view returns (uint256) {
        return asset.balanceOf(address(this)) - pendingDepositAssets;
    }

    /** Current OPEN-phase price, 1e18-scaled. Meaningless while DEPLOYED. */
    function openPrice() public view returns (uint256) {
        return ((cash() + VIRTUAL) * PRICE_ONE) / (totalSupply + VIRTUAL);
    }

    function queueLengths() external view returns (uint256 deposits, uint256 withdraws) {
        return (pendingDeposits.length, pendingWithdraws.length);
    }

    // ----------------------------------------------------- holder actions
    //
    // One verb each way, whatever the phase: while the vault is flat the
    // action executes instantly at the exact balance price; while the money is
    // out working it queues and executes at the next settle's snapshot. The
    // caller never has to know which — the events say what happened.

    /** Deposit your own collateral. Requires a one-time ERC-20 approval. */
    function deposit(uint256 assets) external {
        if (assets == 0) revert ZeroAmount();
        _pull(msg.sender, assets);
        _credit(msg.sender, assets);
    }

    /**
     * Deposit in ONE transaction with no approval at all: the vault mints the
     * test collateral to itself from the token's open faucet and credits the
     * shares. Only meaningful on a testnet, and only honest because the same
     * faucet is open to everyone anyway — a depositor with a wallet full of
     * tUSDC and one with an empty wallet can mint identical positions either
     * way, so no holder is diluted by anything they could not have done
     * themselves for free.
     */
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
            _push(msg.sender, assets);
            emit InstantWithdraw(msg.sender, shares, assets);
        } else {
            if (pendingWithdraws.length >= QUEUE_CAP) revert QueueFull();
            // Escrow the shares in the vault; they burn at settle.
            _transfer(msg.sender, address(this), shares);
            pendingWithdraws.push(Pending(msg.sender, uint128(shares)));
            pendingWithdrawShares += shares;
            emit WithdrawRequested(msg.sender, epoch, shares);
        }
    }

    /** Collateral is in the vault; mint now (flat) or queue for the settle. */
    function _credit(address account, uint256 assets) internal {
        if (phase == Phase.OPEN) {
            // The assets are already in the balance, so price off the pot as
            // it stood before they arrived.
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

    // --------------------------------------------------- operator actions

    /** Take the flat pot out to buy this side of every live window. */
    function deployFunds() external returns (uint256 assets) {
        if (msg.sender != operator) revert NotOperator();
        if (phase != Phase.OPEN) revert WrongPhase();
        assets = cash();
        if (assets == 0) revert NothingToDeploy();
        phase = Phase.DEPLOYED;
        _push(operator, assets);
        emit FundsDeployed(epoch, assets);
    }

    /**
     * Close the epoch. The operator must have transferred every proceed back
     * before calling — the price IS the resulting balance, so under-returning
     * is visible to everyone as a price drop, on-chain, forever.
     */
    function settleEpoch() external {
        if (msg.sender != operator) revert NotOperator();
        if (phase != Phase.DEPLOYED) revert WrongPhase();

        // One snapshot price for everyone in both queues.
        uint256 pot = cash();
        uint256 price = ((pot + VIRTUAL) * PRICE_ONE) / (totalSupply + VIRTUAL);

        // Withdrawals first: burn the escrowed shares, pay at the snapshot.
        for (uint256 i = 0; i < pendingWithdraws.length; i++) {
            Pending memory request = pendingWithdraws[i];
            uint256 assets = (uint256(request.amount) * price) / PRICE_ONE;
            _burn(address(this), request.amount);
            _push(request.account, assets);
            emit InstantWithdraw(request.account, request.amount, assets);
        }
        delete pendingWithdraws;
        pendingWithdrawShares = 0;

        // Then deposits, at the same snapshot.
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

    function setOperator(address operator_) external {
        if (msg.sender != owner) revert NotOwner();
        operator = operator_;
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

    function _pull(address from, uint256 assets) internal {
        if (!asset.transferFrom(from, address(this), assets)) revert();
    }

    function _push(address to, uint256 assets) internal {
        if (!asset.transfer(to, assets)) revert();
    }
}
