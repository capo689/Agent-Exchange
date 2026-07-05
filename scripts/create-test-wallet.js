import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

console.log(JSON.stringify({
  warning: 'Throwaway Base Sepolia test wallet only. Do not send real funds to this wallet.',
  address: account.address,
  privateKey
}, null, 2));
