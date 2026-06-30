import pino from 'pino';

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

export function truncateForLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…';
}

export const log = createLogger('app');
export const embedLog = log.child({ component: 'embed' });
export const qdrantLog = log.child({ component: 'qdrant' });
export const uploadLog = log.child({ component: 'upload' });
export const downloadLog = log.child({ component: 'download' });
export const chatLog = log.child({ component: 'chat' });
export const searchLog = log.child({ component: 'search' });
export const llmLog = log.child({ component: 'llm' });
export const parserLog = log.child({ component: 'parser' });
export const chunkLog = log.child({ component: 'chunk' });