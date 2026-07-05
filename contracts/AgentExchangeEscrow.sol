// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract AgentExchangeEscrow {
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

    mapping(bytes32 => Escrow) public escrows;

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

    constructor(address asset_, address platformFeeRecipient_, address arbitrator_, uint16 platformFeeBps_) {
        require(asset_ != address(0), "asset required");
        require(platformFeeRecipient_ != address(0), "fee recipient required");
        require(arbitrator_ != address(0), "arbitrator required");
        require(platformFeeBps_ <= MAX_FEE_BPS, "fee too high");

        asset = IERC20(asset_);
        platformFeeRecipient = platformFeeRecipient_;
        arbitrator = arbitrator_;
        platformFeeBps = platformFeeBps_;
    }

    function fund(bytes32 tradeIdHash, string calldata tradeId, address seller, uint256 amount) external {
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

        require(asset.transferFrom(msg.sender, address(this), amount), "transfer failed");
        emit EscrowFunded(tradeIdHash, tradeId, msg.sender, seller, amount, platformFeeBps);
    }

    function release(bytes32 tradeIdHash) external {
        Escrow storage escrow = escrows[tradeIdHash];
        require(escrow.state == State.Funded, "not funded");
        require(msg.sender == escrow.buyer || msg.sender == arbitrator, "buyer or arbitrator required");

        escrow.state = State.Released;
        uint256 fee = (escrow.amount * escrow.feeBps) / 10000;
        uint256 sellerAmount = escrow.amount - fee;

        if (fee > 0) {
            require(asset.transfer(platformFeeRecipient, fee), "fee transfer failed");
        }
        require(asset.transfer(escrow.seller, sellerAmount), "seller transfer failed");

        emit EscrowReleased(tradeIdHash, escrow.seller, sellerAmount, fee);
    }

    function refund(bytes32 tradeIdHash) external {
        Escrow storage escrow = escrows[tradeIdHash];
        require(escrow.state == State.Funded, "not funded");
        require(msg.sender == escrow.seller || msg.sender == arbitrator, "seller or arbitrator required");

        escrow.state = State.Refunded;
        require(asset.transfer(escrow.buyer, escrow.amount), "refund transfer failed");

        emit EscrowRefunded(tradeIdHash, escrow.buyer, escrow.amount);
    }

    function escrowOf(bytes32 tradeIdHash) external view returns (Escrow memory) {
        return escrows[tradeIdHash];
    }
}
