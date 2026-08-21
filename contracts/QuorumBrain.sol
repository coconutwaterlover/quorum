// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import {SomniaExtensions} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";

interface IQuorumVault {
    function noteWindow(
        bytes32 marketId,
        address market,
        address pool,
        uint256 yesId,
        uint256 noId,
        uint64 tradingStart,
        uint64 expiry
    ) external;
    function runEpoch() external;
    function redeemAndSettle() external;
    function enterNow() external;
    function plannedContracts() external view returns (uint256);
    function liveUnentered() external view returns (bytes32[] memory);
    function pairMake(bytes32 marketId, uint256 quantity) external;
    function pairCross(bytes32 marketId, uint256 quantity) external;
}

/**
 * QuorumBrain — the one contract that keeps both vaults alive, with nothing
 * running anywhere.
 *
 * Two reactivity subscriptions, both owned here so a single 32 STT bond covers
 * the pair of vaults:
 *
 *   1. EVENTS: the venue's MarketCreator emits MarketCreated as each window is
 *      minted. The chain delivers those straight into `_onEvent`, which filters
 *      for the 15-minute cadence and feeds both vaults' buckets. Market
 *      discovery is therefore chain-fed — no operator decides what the vaults
 *      may trade.
 *   2. SCHEDULE: a self-re-arming quarter-hour wake-up (the ArenaClock pattern,
 *      which ran unattended for weeks) fires shortly after each boundary, when
 *      the oracle has answered, and calls `runEpoch()` on both vaults: redeem,
 *      settle, re-enter.
 *
 * Everything here is a convenience, not an authority: `runEpoch` is
 * permissionless on the vaults and `rearm`/`pokeVaults` are permissionless
 * here, so a dropped callback — or this whole contract going unfunded — can be
 * healed by any EOA. The brain can nudge the vaults; it can never touch money.
 */
contract QuorumBrain is SomniaEventHandler {
    /// keccak256 of the venue MarketCreator's 13-field MarketCreated event.
    bytes32 public constant MARKET_CREATED_TOPIC =
        0xcef65022605efd3d0e3c05c0a1b84d7ba9dfa8252f58a4f65867eb1ea3f6c300;
    uint256 public constant WINDOW_SECONDS = 900;
    /// Fire this long after the boundary: the oracle answers within seconds of
    /// expiry, and landing exactly on the boundary risks a stale timestamp.
    uint256 public constant BOUNDARY_OFFSET = 45;
    uint64 public constant CALLBACK_GAS_LIMIT = 30_000_000;

    address public immutable admin;
    address public immutable marketCreator;
    IQuorumVault public immutable up;
    IQuorumVault public immutable down;

    uint256 public eventSubscriptionId;
    uint256 public scheduleSubscriptionId;
    uint256 public armedForMs;
    uint256 public fireCount;
    uint256 public windowsFed;
    uint256 public pairsMinted;

    event Armed(uint256 indexed scheduleId, uint256 timestampMs);
    event EventsArmed(uint256 indexed subscriptionId);
    event Fired(uint256 indexed fireCount);
    event RearmFailed(bytes reason);
    event Funded(address indexed from, uint256 amount);

    error OnlyAdmin();
    error AlreadyArmed();

    constructor(address marketCreator_, IQuorumVault up_, IQuorumVault down_) payable {
        admin = msg.sender;
        marketCreator = marketCreator_;
        up = up_;
        down = down_;
    }

    function minimumBalance() external pure returns (uint256) {
        return SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE;
    }

    function isFunded() public view returns (bool) {
        return address(this).balance >= SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE;
    }

    /** Subscribe to the venue's MarketCreated stream. Permissionless, once. */
    function armEvents() external returns (uint256) {
        if (eventSubscriptionId != 0) revert AlreadyArmed();
        bytes32[4] memory topics;
        topics[0] = MARKET_CREATED_TOPIC;
        eventSubscriptionId = SomniaExtensions.subscribe(
            address(this),
            SomniaExtensions.SubscriptionFilter({
                eventTopics: topics,
                origin: address(0),
                emitter: marketCreator
            }),
            SomniaExtensions.SubscriptionOptions({
                priorityFeePerGas: 1,
                maxFeePerGas: 0,
                gasLimit: CALLBACK_GAS_LIMIT
            })
        );
        emit EventsArmed(eventSubscriptionId);
        return eventSubscriptionId;
    }

    function nextBoundaryMs() public view returns (uint256) {
        uint256 next = ((block.timestamp / WINDOW_SECONDS) + 1) * WINDOW_SECONDS + BOUNDARY_OFFSET;
        while (next <= block.timestamp + 1) next += WINDOW_SECONDS;
        return next * 1000;
    }

    /** Arm (or heal) the quarter-hour heartbeat. Permissionless. */
    function rearm() public returns (uint256) {
        uint256 target = nextBoundaryMs();
        if (armedForMs == target) revert AlreadyArmed();
        scheduleSubscriptionId = SomniaExtensions.scheduleSubscriptionAtTimestamp(
            address(this),
            target,
            SomniaExtensions.SubscriptionOptions({
                priorityFeePerGas: 1,
                maxFeePerGas: 0,
                gasLimit: CALLBACK_GAS_LIMIT
            })
        );
        armedForMs = target;
        emit Armed(scheduleSubscriptionId, target);
        return scheduleSubscriptionId;
    }

    /**
     * Run both vaults' machines now. Permissionless — reverts never propagate.
     * Order matters: settle both, pair-mint the overlap (Up rests at mid, Down
     * crosses it in this same transaction — zero spread on that size), then let
     * each vault's residual IOC entry top up whatever the pair didn't cover.
     */
    function pokeVaults() public {
        try up.redeemAndSettle() {} catch {}
        try down.redeemAndSettle() {} catch {}
        _pairAll();
        try up.enterNow() {} catch {}
        try down.enterNow() {} catch {}
    }

    function _pairAll() internal {
        uint256 wantUp;
        uint256 wantDown;
        try up.plannedContracts() returns (uint256 v) {
            wantUp = v;
        } catch {
            return;
        }
        try down.plannedContracts() returns (uint256 v) {
            wantDown = v;
        } catch {
            return;
        }
        uint256 overlap = wantUp < wantDown ? wantUp : wantDown;
        if (overlap == 0) return;

        bytes32[] memory markets;
        try up.liveUnentered() returns (bytes32[] memory m) {
            markets = m;
        } catch {
            return;
        }
        for (uint256 i = 0; i < markets.length; i++) {
            // A failed make leaves nothing behind; a failed cross leaves a
            // fair-priced maker order that expires on its own within seconds.
            try up.pairMake(markets[i], overlap) {
                try down.pairCross(markets[i], overlap) {
                    unchecked {
                        pairsMinted += 1;
                    }
                } catch {}
            } catch {}
        }
    }

    function _onEvent(address emitter, bytes32[] calldata eventTopics, bytes calldata data) internal override {
        if (emitter == marketCreator && eventTopics.length >= 4 && eventTopics[0] == MARKET_CREATED_TOPIC) {
            _onMarketCreated(eventTopics, data);
            return;
        }

        // Scheduled boundary fire: work both vaults and put the next wake-up on.
        unchecked {
            fireCount += 1;
        }
        pokeVaults();
        armedForMs = 0;
        try this.rearm() {} catch (bytes memory reason) {
            emit RearmFailed(reason);
        }
        emit Fired(fireCount);
    }

    function _onMarketCreated(bytes32[] calldata eventTopics, bytes calldata data) internal {
        (
            uint256 yesId,
            uint256 noId,
            ,
            ,
            ,
            uint64 tradingStart,
            uint64 expiry,
            ,
            ,
            uint64 intervalSec
        ) = abi.decode(data, (uint256, uint256, address, string, uint256, uint64, uint64, uint256, string, uint64));
        if (intervalSec != WINDOW_SECONDS) return;

        bytes32 marketId = eventTopics[1];
        address market = address(uint160(uint256(eventTopics[2])));
        address pool = address(uint160(uint256(eventTopics[3])));

        try up.noteWindow(marketId, market, pool, yesId, noId, tradingStart, expiry) {} catch {}
        try down.noteWindow(marketId, market, pool, yesId, noId, tradingStart, expiry) {} catch {}
        unchecked {
            windowsFed += 1;
        }
    }

    /** Top up the bond that keeps the callbacks paying for themselves. */
    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        if (msg.sender != admin) revert OnlyAdmin();
        (bool ok, ) = admin.call{value: amount}("");
        require(ok);
    }
}
