import pino from 'pino';
import path from 'path';

const __filename = import.meta.url.split('/').pop()?.replace('.ts', '') ?? 'unknown';

export function createLogger(name: string) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    base: {
      name,
      pid: process.pid,
    },
    transport: process.env.NODE_ENV === 'production' ? undefined : {
      target: 'pino-pretty',
      options: {
        translateTime: 'YYYY-MM-DD HH:mm:ss.SSS',
        ignore: 'pid,hostname',
      },
    },
  });
}

export function childLogger(parent: pino.Logger, suffix: string) {
  return parent.child({ component: suffix });
}

// Shared loggers per module - call once and reuse
export const log = createLogger('app');
export const embedLog = log.child({ component: 'embed' });
export const qdrantLog = log.child({ component: 'qdrant' });
export const uploadLog = log.child({ component: 'upload' });
export const donwloadLog = log.child({ component: 'download' });
export const chatLog = log.child({ component: 'chat' });
export const searchLog = log.child({ component: 'search' });
export const llmLog = log.child({ component: 'llm' });