pragma solidity ^0.8.0;

contract EcrecoverCheck {
    function check(
        bytes32 hash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external view returns (address) {
        address recovered = ecrecover(hash, v, r, s);
        require(recovered != address(0), "invalid signature");
        require(recovered == msg.sender, "signer mismatch");
        return recovered;
    }
}
