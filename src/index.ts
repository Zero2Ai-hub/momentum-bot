/**
 * Solana Momentum Trading Bot
 * Main Entry Point
 * 
 * Detects and trades tokens with emerging momentum using
 * on-chain signals only.
 */

import { loadConfig } from './config/config';
import { initializeLogger, log, closeLogger } from './logging/logger';
import { createBot, MomentumBot } from './bot';

let bot: MomentumBot | null = null;

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║                                                                               ║
║     ███╗   ███╗ ██████╗ ███╗   ███╗███████╗███╗   ██╗████████╗██╗   ██╗███╗   ███╗ ║
║     ████╗ ████║██╔═══██╗████╗ ████║██╔════╝████╗  ██║╚══██╔══╝██║   ██║████╗ ████║ ║
║     ██╔████╔██║██║   ██║██╔████╔██║█████╗  ██╔██╗ ██║   ██║   ██║   ██║██╔████╔██║ ║
║     ██║╚██╔╝██║██║   ██║██║╚██╔╝██║██╔══╝  ██║╚██╗██║   ██║   ██║   ██║██║╚██╔╝██║ ║
║     ██║ ╚═╝ ██║╚██████╔╝██║ ╚═╝ ██║███████╗██║ ╚████║   ██║   ╚██████╔╝██║ ╚═╝ ██║ ║
║     ╚═╝     ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝ ║
║                                                                               ║
║                    SOLANA ON-CHAIN MOMENTUM TRADING BOT                      ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
  `);
  
  // Load configuration
  try {
    loadConfig();
  } catch (error) {
    console.error('Failed to load configuration:', (error as Error).message);
    console.error('Make sure you have a .env file with required settings.');
    console.error('See config.example.env for reference.');
    process.exit(1);
  }
  
  // Initialize logger
  initializeLogger();
  
  log.info('Momentum Bot starting...');
  log.info('─────────────────────────────────────────────────────────────────');
  
  // Create and initialize bot
  bot = createBot();
  
  const initialized = await bot.initialize();
  if (!initialized) {
    log.error('Failed to initialize bot');
    process.exit(1);
  }
  
  // Set up graceful shutdown
  setupShutdownHandlers();
  
  // Start the bot
  await bot.start();
  
  // Log initial status
  log.info('Bot is now scanning for momentum opportunities...');
  log.info('Press Ctrl+C to stop');
}

/**
 * Set up handlers for graceful shutdown
 */
function setupShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    
    if (bot) {
      await bot.stop();
    }
    
    await closeLogger();
    process.exit(0);
  };
  
  // Handle various termination signals
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  
  // Handle uncaught errors
  process.on('uncaughtException', async (error) => {
    log.error('Uncaught exception', error);
    
    if (bot) {
      await bot.stop();
    }
    
    await closeLogger();
    process.exit(1);
  });
  
  process.on('unhandledRejection', async (reason, promise) => {
    log.error('Unhandled rejection', reason as Error, { promise: String(promise) });
  });
}

// Run the bot
main().catch(async (error) => {
  console.error('Fatal error:', error);
  
  if (bot) {
    await bot.stop();
  }
  
  process.exit(1);
});
