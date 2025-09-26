// Standard fee tiers for Uniswap V3 and PancakeSwap V3
// PancakeSwap V3 supports: 100 (0.01%), 500 (0.05%), 2500 (0.25%), 10000 (1%)
// Uniswap V3 supports: 100 (0.01%), 500 (0.05%), 3000 (0.3%), 10000 (1%)
const feeTiers = [100, 500, 2500, 3000, 10000];

const protocolAddresses = {
    uniswapV3Factory: "0x961235a9020B05C44DF1026D956D1F4D78014276",
    pancakeV3Factory: "0x3b7838D96Fc18AD1972aFa17574686be79C50040", // PancakeSwap V3 Factory
    pancakeQuoterV2: "0x7f988126C2c5d4967Bb5E70bDeB7e26DB6BD5C28", 
    uniswapQuoterV2: "0x1b4E313fEF15630AF3e6F2dE550Dbf4cC9D3081d",
    WMON: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701",
    // WMON: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
}

export default {
    feeTiers,
    protocolAddresses,
};

