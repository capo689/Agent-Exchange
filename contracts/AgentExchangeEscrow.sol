// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract AgentExchangeEscrow {
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    enum State {
        None,
        Funded,
        Released,
        Refunded
    }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;
        uint16 feeBps;
        State state;
    }

    uint16 public constant MAX_FEE_BPS = 1000;

    IERC20 public immutable asset;
    address public immutable platformFeeRecipient;
    address public immutable arbitrator;
    uint16 public immutable platformFeeBps;
    uint256 private locked = NOT_ENTERED;

    mapping(bytes32 => Escrow) public escrows;

    event EscrowConfigured(
        address indexed asset,
        address indexed platformFeeRecipient,
        address indexed arbitrator,
        uint16 platformFeeBps
    );
    event EscrowFunded(
        bytes32 indexed tradeIdHash,
        string tradeId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint16 feeBps
    );
    event EscrowReleased(
        bytes32 indexed tradeIdHash,
        address indexed seller,
        uint256 sellerAmount,
        uint256 platformFee
    );
    event EscrowRefunded(bytes32 indexed tradeIdHash, address indexed buyer, uint256 amount);

    modifier nonReentrant() {
        require(locked == NOT_ENTERED, "reentrant call");
        locked = ENTERED;
        _;
        locked = NOT_ENTERED;
    }

    constructor(address asset_, address platformFeeRecipient_, address arbitrator_, uint16 platformFeeBps_) {
        require(asset_ != address(0), "asset required");
        require(platformFeeRecipient_ != address(0), "fee recipient required");
        require(arbitrator_ != address(0), "arbitrator required");
        require(platformFeeBps_ <= MAX_FEE_BPS, "fee too high");

        asset = IERC20(asset_);
        platformFeeRecipient = platformFeeRecipient_;
        arbitrator = arbitrator_;
        platformFeeBps = platformFeeBps_;

        emit EscrowConfigured(asset_, platformFeeRecipient_, arbitrator_, platformFeeBps_);
    }

    function fund(bytes32 tradeIdHash, string calldata tradeId, address seller, uint256 amount) external nonReentrant {
        require(tradeIdHash != bytes32(0), "trade hash required");
        require(bytes(tradeId).length > 0, "trade id required");
        require(seller != address(0), "seller required");
        require(seller != msg.sender, "self trade blocked");
        require(amount > 0, "amount required");
        require(escrows[tradeIdHash].state == State.None, "already funded");

        escrows[tradeIdHash] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            feeBps: platformFeeBps,
            state: State.Funded
        });

        _safeTransferFrom(msg.sender, address(this), amount);
        emit EscrowFunded(tradeIdHash, tradeId, msg.sender, seller, amount, platformFeeBps);
    }

    function release(bytes32 tradeIdHash) external nonReentrant {
        Escrow storage escrow = _fundedEscrow(tradeIdHash);
        require(msg.sender == escrow.buyer || msg.sender == arbitrator, "buyer or arbitrator required");

        escrow.state = State.Released;
        uint256 fee = _platformFee(escrow.amount, escrow.feeBps);
        uint256 sellerAmount = escrow.amount - fee;

        if (fee > 0) {
            _safeTransfer(platformFeeRecipient, fee);
        }
        _safeTransfer(escrow.seller, sellerAmount);

        emit EscrowReleased(tradeIdHash, escrow.seller, sellerAmount, fee);
    }

    function refund(bytes32 tradeIdHash) external nonReentrant {
        Escrow storage escrow = _fundedEscrow(tradeIdHash);
        require(msg.sender == escrow.seller || msg.sender == arbitrator, "seller or arbitrator required");

        escrow.state = State.Refunded;
        _safeTransfer(escrow.buyer, escrow.amount);

        emit EscrowRefunded(tradeIdHash, escrow.buyer, escrow.amount);
    }

    function escrowOf(bytes32 tradeIdHash) external view returns (Escrow memory) {
        return escrows[tradeIdHash];
    }

    function _fundedEscrow(bytes32 tradeIdHash) internal view returns (Escrow storage escrow) {
        require(tradeIdHash != bytes32(0), "trade hash required");
        escrow = escrows[tradeIdHash];
        require(escrow.state == State.Funded, "not funded");
        require(escrow.buyer != address(0), "buyer missing");
        require(escrow.seller != address(0), "seller missing");
        require(escrow.amount > 0, "amount missing");
    }

    function _platformFee(uint256 amount, uint16 feeBps) internal pure returns (uint256) {
        // Rounds down intentionally so the platform never overcharges by a dust unit.
        return (amount * feeBps) / 10000;
    }

    function _safeTransfer(address to, uint256 value) internal {
        _callToken(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
    }

    function _safeTransferFrom(address from, address to, uint256 value) internal {
        _callToken(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value));
    }

    function _callToken(bytes memory data) internal {
        (bool success, bytes memory returndata) = address(asset).call(data);
        require(success, "token call failed");
        require(returndata.length == 0 || abi.decode(returndata, (bool)), "token operation failed");
    }
}
