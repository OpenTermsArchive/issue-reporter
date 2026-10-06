import os from 'os';

import config from 'config';
import winston from 'winston';
import 'winston-mail';

const { combine, timestamp, printf, colorize } = winston.format;

const logger = winston.createLogger({
  format: combine(
    colorize(),
    timestamp({ format: 'YYYY-MM-DDTHH:mm:ssZ' }),
    printf(({ level, message, timestamp }) => {
      const timestampPrefix = config.get('@opentermsarchive/issue-reporter.logger.timestampPrefix') ? `${timestamp} ` : '';

      return `${timestampPrefix}${level.padEnd(15)} ${message}`;
    }),
  ),
  transports: [new winston.transports.Console({ silent: process.env.NODE_ENV === 'test', handleRejections: true })],
  exitOnError: false,
});

if (config.get('@opentermsarchive/issue-reporter.logger.sendMailOnError')) {
  if (process.env.OTA_ISSUE_REPORTER_SMTP_PASSWORD === undefined) {
    logger.warn('Environment variable "OTA_ISSUE_REPORTER_SMTP_PASSWORD" was not found; log emails cannot be sent');
  } else {
    logger.add(new winston.transports.Mail({
      to: config.get('@opentermsarchive/issue-reporter.logger.sendMailOnError.to'),
      from: config.get('@opentermsarchive/issue-reporter.logger.sendMailOnError.from'),
      host: config.get('@opentermsarchive/issue-reporter.logger.smtp.host'),
      port: config.get('@opentermsarchive/issue-reporter.logger.smtp.port'),
      username: config.get('@opentermsarchive/issue-reporter.logger.smtp.username'),
      password: process.env.OTA_ISSUE_REPORTER_SMTP_PASSWORD,
      tls: true,
      timeout: 30 * 1000,
      level: 'error',
      subject: `[OTA] [Issue Reporter] Error — ${os.hostname()}`,
      formatter: ({ message }) => message,
      handleRejections: true,
    }));
  }
}

export default logger;
