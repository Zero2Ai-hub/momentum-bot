/**
 * Structured logging for the trading bot.
 * Uses Winston for flexible output formatting and file rotation.
 */

import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { getConfig } from '../config/config';
import { LogEvent, LogEventType } from '../types';

// Ensure log directory exists
function ensureLogDir(logDir: string): void {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

// Messages to show in console (patterns)
const CONSOLE_WHITELIST_PATTERNS = [
  /🔥 HOT TOKEN DETECTED/,
  /✅ Token ENTERED universe/,
  /━━━━━━━━/,  // Status report separator
  /📊 STATUS/,
  /🔍 PHASE 1/,
  /📈 Waiting for momentum/,
  /💰 TRADES/,
  /⏳ No trades yet/,
  /═══.*ENTRY OPPORTUNITY/,
  /ENTRY_SIGNAL/,
  /EXIT_SIGNAL/,
  /POSITION_OPENED/,
  /POSITION_CLOSED/,
  /🔥 MOMENTUM:/,
  /\[PAPER\]/,
  /TRADE:/,
  /🔴 FLOW_REVERSAL/,
  /Momentum Bot/,
  /PAPER TRADING MODE/,
  /Bot is now scanning/,
  /Press Ctrl\+C/,
  /╔═/,  // Banner
  /║/,   // Banner  
  /╚═/,  // Banner
  /─────/,  // Separator
];

// Filter for console - only show whitelisted messages
const consoleFilter = winston.format((info) => {
  const message = String(info.message || '');
  const isWhitelisted = CONSOLE_WHITELIST_PATTERNS.some(pattern => pattern.test(message));
  return isWhitelisted ? info : false;
});

// Custom format for console output
const consoleFormat = winston.format.combine(
  consoleFilter(),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// JSON format for file output (machine-readable)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

let loggerInstance: winston.Logger | null = null;
let eventLogStream: fs.WriteStream | null = null;

export function initializeLogger(): winston.Logger {
  const config = getConfig();
  ensureLogDir(config.logDir);
  
  loggerInstance = winston.createLogger({
    level: config.logLevel,
    transports: [
      // Console output for human monitoring
      new winston.transports.Console({
        format: consoleFormat,
      }),
      // File output for persistent logs
      new winston.transports.File({
        filename: path.join(config.logDir, 'bot.log'),
        format: fileFormat,
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
      }),
      // Separate error log
      new winston.transports.File({
        filename: path.join(config.logDir, 'error.log'),
        level: 'error',
        format: fileFormat,
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
      }),
    ],
  });
  
  // Initialize event log stream for replay system (JSON Lines format)
  const eventLogPath = path.join(
    config.logDir, 
    `events_${new Date().toISOString().slice(0, 10)}.jsonl`
  );
  eventLogStream = fs.createWriteStream(eventLogPath, { flags: 'a' });
  
  return loggerInstance;
}

export function getLogger(): winston.Logger {
  if (!loggerInstance) {
    return initializeLogger();
  }
  return loggerInstance;
}

/**
 * Log a structured event for replay/analysis
 */
export function logEvent(type: LogEventType, data: Record<string, unknown>): void {
  const event: LogEvent = {
    type,
    timestamp: Date.now(),
    data,
  };
  
  // Write to event log stream for replay
  if (eventLogStream) {
    eventLogStream.write(JSON.stringify(event) + '\n');
  }
  
  // Also log to winston with appropriate level
  const logger = getLogger();
  
  switch (type) {
    case LogEventType.ERROR:
    case LogEventType.ORDER_FAILED:
      logger.error(type, data);
      break;
    case LogEventType.ENTRY_SIGNAL:
    case LogEventType.EXIT_SIGNAL:
    case LogEventType.POSITION_OPENED:
    case LogEventType.POSITION_CLOSED:
    case LogEventType.PHASE2_VERIFIED:
    case LogEventType.RPC_COUNTERS:
      logger.info(type, data);
      break;
    case LogEventType.SWAP_DETECTED:
    case LogEventType.RISK_GATE_CHECK:
    case LogEventType.TOKEN_ENTERED_UNIVERSE:
    case LogEventType.TOKEN_EXITED_UNIVERSE:
    case LogEventType.PHASE1_CANDIDATE_SEEN:
    case LogEventType.PHASE1_HOT_TRIGGERED:
    case LogEventType.PHASE1_COOLDOWN_SKIP:
    case LogEventType.PHASE2_STARTED:
    case LogEventType.PHASE2_REJECTED:
    case LogEventType.PHASE2_NOISE_REJECTED:
      logger.debug(type, data);
      break;
    default:
      logger.info(type, data);
  }
}

/**
 * Log helpers for common scenarios
 */
export const log = {
  info: (message: string, meta?: Record<string, unknown>) => {
    getLogger().info(message, meta);
  },
  
  warn: (message: string, meta?: Record<string, unknown>) => {
    getLogger().warn(message, meta);
  },
  
  error: (message: string, error?: Error, meta?: Record<string, unknown>) => {
    getLogger().error(message, {
      ...meta,
      error: error?.message,
      stack: error?.stack,
    });
  },
  
  debug: (message: string, meta?: Record<string, unknown>) => {
    getLogger().debug(message, meta);
  },
  
  trade: (action: string, details: Record<string, unknown>) => {
    getLogger().info(`TRADE: ${action}`, details);
  },
};

/**
 * Close log streams gracefully
 */
export function closeLogger(): Promise<void> {
  return new Promise((resolve) => {
    if (eventLogStream) {
      eventLogStream.end(() => {
        eventLogStream = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
