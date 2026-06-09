// Structured logging for the SFU — mirrors lens.sideby.me/src/telemetry/logs.ts.
// Every log is written to the console as a JSON line AND (when telemetry is enabled
// by the bootstrap) emitted as an OTEL log record. Emission is fail-open: a broken
// exporter must never break the media plane.
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

type SfuLogLevel = 'info' | 'warn' | 'error';
type SfuAttributeValue = string | number | boolean;

interface SfuStructuredLog {
  level: SfuLogLevel;
  service: 'sfu';
  domain?: string;
  event?: string;
  message: string;
  ts: number;
  meta?: Record<string, unknown>;
}

let telemetryLogsEnabled = false;
let telemetryLoggerVersion = '1.0.0';

function mapSeverityNumber(level: SfuLogLevel): SeverityNumber {
  switch (level) {
    case 'error':
      return SeverityNumber.ERROR;
    case 'warn':
      return SeverityNumber.WARN;
    default:
      return SeverityNumber.INFO;
  }
}

function buildStructuredLog(level: SfuLogLevel, message: string, meta?: Record<string, unknown>): SfuStructuredLog {
  const domain = typeof meta?.domain === 'string' ? meta.domain : undefined;
  const event = typeof meta?.event === 'string' ? meta.event : undefined;

  return {
    level,
    service: 'sfu',
    domain,
    event,
    message,
    ts: Date.now(),
    meta: meta && Object.keys(meta).length > 0 ? meta : undefined,
  };
}

function extractTelemetryAttributes(payload: SfuStructuredLog): Record<string, SfuAttributeValue> {
  const attributes: Record<string, SfuAttributeValue> = {
    'log.level': payload.level,
    'log.source': 'sfu.application',
    service: payload.service,
  };

  if (payload.domain) {
    attributes.domain = payload.domain;
  }
  if (payload.event) {
    attributes.event = payload.event;
  }

  if (payload.meta) {
    for (const [key, value] of Object.entries(payload.meta)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        attributes[key] = value;
      }
    }
  }

  return attributes;
}

function emitSfuTelemetryLog(
  level: SfuLogLevel,
  message: string,
  attributes?: Record<string, SfuAttributeValue>
): void {
  if (!telemetryLogsEnabled) {
    return;
  }

  try {
    const logger = logs.getLogger('sfu.sideby.me.logs', telemetryLoggerVersion);
    logger.emit({
      severityNumber: mapSeverityNumber(level),
      severityText: level.toUpperCase(),
      body: message,
      attributes,
    });
  } catch {
    // Fail-open: log emission must never break core service behavior.
  }
}

function writeConsole(level: SfuLogLevel, payload: SfuStructuredLog): void {
  const line = JSON.stringify(payload);

  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

function writeAndEmit(level: SfuLogLevel, message: string, meta?: Record<string, unknown>): void {
  const payload = buildStructuredLog(level, message, meta);
  writeConsole(level, payload);
  emitSfuTelemetryLog(level, JSON.stringify(payload), extractTelemetryAttributes(payload));
}

export function enableSfuTelemetryLogs(version?: string): void {
  telemetryLoggerVersion = version?.trim() || telemetryLoggerVersion;
  telemetryLogsEnabled = true;
}

export function disableSfuTelemetryLogs(): void {
  telemetryLogsEnabled = false;
}

export function logInfo(message: string, meta?: Record<string, unknown>): void {
  writeAndEmit('info', message, meta);
}

export function logWarn(message: string, meta?: Record<string, unknown>): void {
  writeAndEmit('warn', message, meta);
}

export function logError(message: string, meta?: Record<string, unknown>): void {
  writeAndEmit('error', message, meta);
}
