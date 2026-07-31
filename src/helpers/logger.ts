import pino from 'pino';
import { scrubAny } from './scrub';

export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    // Single choke point: every log line is redacted before it is formatted, so
    // an upstream error string carrying an RPC key or a URL password cannot
    // reach stdout (and from there the platform's log store).
    hooks: {
        logMethod(args, method) {
            return method.apply(this, args.map(scrubAny) as Parameters<typeof method>);
        },
    },
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            singleLine: true,
            levelFirst: true,
        },
    },
});
