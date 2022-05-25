import winston from 'winston';

const logger = winston.createLogger({
    level: "debug",
    transports: [
        new winston.transports.Console()
    ],
    format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.splat(), 
        winston.format.cli()
      )
});

export default logger;