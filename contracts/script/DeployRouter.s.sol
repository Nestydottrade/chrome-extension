// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {NestyRouter, ISignatureTransfer} from "../src/NestyRouter.sol";

/// @notice Deploys NestyRouter through the deterministic CREATE2 deployer, so it gets the
///         same address on every chain. The address depends only on the deployer, the
///         salt and the init code (bytecode + the Permit2 constructor argument): never on
///         the wallet or its nonce. Any change to the contract or to the compiler settings
///         in foundry.toml changes the address.
///
///         forge script script/DeployRouter.s.sol --sig "predict()"
///         forge script script/DeployRouter.s.sol --rpc-url base             # dry run
///         forge script script/DeployRouter.s.sol --rpc-url base --broadcast --interactives 1
contract DeployRouter is Script {
    /// The CREATE2 deployer forge uses for `new X{salt: ...}` in scripts.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// Permit2, at the same address on every chain it is deployed on.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// A new version of the router gets a new salt (and so a new address).
    bytes32 internal constant SALT = 0x2b32243256c24f0866738a8978488bf83c5dbf3e98b817ad95fcb167a39ede66;

    function initCodeHash() public pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(NestyRouter).creationCode, abi.encode(PERMIT2)));
    }

    function predicted() public pure returns (address) {
        return vm.computeCreate2Address(SALT, initCodeHash(), CREATE2_DEPLOYER);
    }

    /// Prints the address the router will have on every chain. No RPC needed.
    function predict() external pure {
        console.log("NestyRouter address:", predicted());
        console.log("init code hash:");
        console.logBytes32(initCodeHash());
    }

    /// Checks the chain behind --rpc-url can host the router. Sends nothing.
    function check() public view returns (bool deployed) {
        require(CREATE2_DEPLOYER.code.length > 0, "CREATE2 deployer missing on this chain");
        require(PERMIT2.code.length > 0, "Permit2 missing on this chain");
        deployed = predicted().code.length > 0;
        console.log("chain id:", block.chainid);
        console.log("CREATE2 deployer and Permit2: present");
        console.log(deployed ? "router: already deployed" : "router: not deployed yet");
    }

    function run() external returns (NestyRouter router) {
        address expected = predicted();
        if (check()) return NestyRouter(payable(expected));

        vm.startBroadcast();
        router = new NestyRouter{salt: SALT}(ISignatureTransfer(PERMIT2));
        vm.stopBroadcast();

        require(address(router) == expected, "deployed at an unexpected address");
        require(address(router.PERMIT2()) == PERMIT2, "wrong Permit2");
        console.log("NestyRouter deployed at:", address(router));
    }
}
