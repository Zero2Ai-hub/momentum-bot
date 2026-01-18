import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "dotenv";
config();

async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL || "");
  const mints = [
    "31TBcxWPPexZ3nSBBkaebhBr9UqLMy6jYBNCSZEJpump",  // Pump.fun token
    "AQwB9fG6RtKN1ie4M5mfPt9prXxkyWyy28RmF5vqgCor"  // Raydium token that passed
  ];
  for (const mint of mints) {
    console.log("\n=== Checking:", mint, "===");
    try {
      const info = await conn.getAccountInfo(new PublicKey(mint));
      if (!info) { 
        console.log("Account not found"); 
        continue; 
      }
      console.log("Owner:", info.owner.toBase58());
      console.log("Data length:", info.data.length);
      console.log("Is 82 bytes (mint)?", info.data.length === 82);
      console.log("Token Program?", info.owner.toBase58() === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    } catch (e) {
      console.log("Error:", (e as Error).message);
    }
  }
}
main().catch(console.error);
