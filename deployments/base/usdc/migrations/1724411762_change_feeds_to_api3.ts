import { ethers } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';
import { expect } from 'chai';

interface Vars {
  wstETHToUSDCPriceFeed: string;
};

const WSTETH_ADDRESS = '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452'

const USDC_USD_PRICE_FEED_ADDRESS = '0x92c5f5010f3011d7B2e1E856D77fb37F4dA8818d'
const ETH_USD_PRICE_FEED_ADDRESS = '0x326d39D0Fa065c5FB3F06A280Ee2Ee9b8e32651d';
const WSTETH_ETH_PRICE_FEED_ADDRESS = '0x2C7747399D360Ea042A49bd9431146Aded6C18eC';

const USDC_COMET_ADDRESS = '0xb125E6687d4313864e53df431d5425969c15Eb2F';

let newWstETHToUSDPriceFeed: string;

// NOTE: To run use:
// DEBUG=true QUICKNODE_KEY=... ETHERSCAN_KEY=... BASESCAN_KEY=... npx hardhat migrate --network base --deployment usdc --prepare --enact --simulate 1724411762_change_feeds_to_api3 --impersonate 0xB933AEe47C438f22DE0747D57fc239FE37878Dd1 --overwrite
export default migration('1724411762_change_feeds_to_api3', {
  prepare: async (deploymentManager: DeploymentManager) => {
    console.log("A1")

    const ethToUsdcPriceFeed = await deploymentManager.deploy(
      'ETH_USDC:priceFeed',
      'pricefeeds/ReverseMultiplicativePriceFeed.sol',
      [
        ETH_USD_PRICE_FEED_ADDRESS,   // ETH / USD price feed
        USDC_USD_PRICE_FEED_ADDRESS,  // USDC / USD price feed
        8,                            // decimals
        'ETH / USD  USD / USDC',      // description
      ],
    );
    console.log("A2")

    const wstETHToUSDCPriceFeed = await deploymentManager.deploy(
      'wstETH_USD:priceFeed',
      'pricefeeds/MultiplicativePriceFeed.sol',
      [
        WSTETH_ETH_PRICE_FEED_ADDRESS,    // wstETH / ETH price feed
        ethToUsdcPriceFeed.address,       // ETH / USDC price feed
        8,                                // decimals
        'wstETH / USDC price feed',       // description
      ],
    );
    console.log("A3")

    return {
      wstETHToUSDCPriceFeed: wstETHToUSDCPriceFeed.address
    }
  },

  enact: async (deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager, vars: Vars) => {
    console.log("B1")
    const {wstETHToUSDCPriceFeed} = vars;
    const trace = deploymentManager.tracer();
    const {
      bridgeReceiver,
      cometAdmin,
      configurator,
    } = await deploymentManager.getContracts();
    const { governor, baseL1CrossDomainMessenger } = await govDeploymentManager.getContracts();

    const wstETH = await deploymentManager.existing(
      'wstETH',
      WSTETH_ADDRESS,
      'base',
      'contracts/ERC20.sol:ERC20'
    );

    newWstETHToUSDPriceFeed = wstETHToUSDCPriceFeed;

    const updateAssetPriceFeedCalldataWstETHToUSDCComet = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'address'],
      [USDC_COMET_ADDRESS, wstETH.address, wstETHToUSDCPriceFeed]
    );

    const deployAndUpgradeToCalldataUSDCComet = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [configurator.address, USDC_COMET_ADDRESS]
    );

    const l2ProposalData = ethers.utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          configurator.address,
          cometAdmin.address,
        ],
        [
          0,
          0,
        ],
        [
          'updateAssetPriceFeed(address,address,address)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          updateAssetPriceFeedCalldataWstETHToUSDCComet,
          deployAndUpgradeToCalldataUSDCComet,
        ]
      ]
    );

    const mainnetActions = [
      // Send the proposal to the L2 bridge
      {
        contract: baseL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [bridgeReceiver.address, l2ProposalData, 3_000_000]
      },
    ];

    const description = '# Update All Price Feeds on Base to API3'; // TODO:
    const txn = await govDeploymentManager.retry(async () =>
      trace(await governor.propose(...(await proposal(mainnetActions, description))))
    );

    const event = txn.events.find(event => event.event === 'ProposalCreated');

    const [proposalId] = event.args;

    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(deploymentManager: DeploymentManager): Promise<boolean> {
    return true;
  },

  async verify(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager, preMigrationBlockNumber: number) {
    console.log('C1')
    const {  comet, configurator } = await deploymentManager.getContracts();

    const wstETHIndexInUSDCComet = await configurator.getAssetIndex(
      comet.address,
      WSTETH_ADDRESS
    );

    const wstETHInUSDCCometInfo = await comet.getAssetInfoByAddress(
      WSTETH_ADDRESS
    );

    const wstETHInConfiguratorInfoUSDCComet = (
      await configurator.getConfiguration(USDC_COMET_ADDRESS)
    ).assetConfigs[wstETHIndexInUSDCComet];

    console.log('C2', wstETHInUSDCCometInfo.priceFeed, newWstETHToUSDPriceFeed)
    expect(wstETHInUSDCCometInfo.priceFeed).to.eq(newWstETHToUSDPriceFeed);
    console.log('C3', wstETHInConfiguratorInfoUSDCComet.priceFeed, newWstETHToUSDPriceFeed)
    expect(wstETHInConfiguratorInfoUSDCComet.priceFeed).to.eq(newWstETHToUSDPriceFeed);
  }
});
