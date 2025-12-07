import pino from 'pino';

export const logger = pino({
    level: 'debug',  // default to debug to show all levels
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            singleLine: true,
            levelFirst: true,
        },
    },
});
