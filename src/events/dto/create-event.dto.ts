import { Transform } from 'class-transformer';
import {
  IsDate,
  IsNotEmpty,
  IsObject,
  IsString,
  MaxDate,
  MaxLength,
  MinDate,
  isISO8601,
} from 'class-validator';

// Only a full ISO 8601 date-time with an explicit offset is a single, unambiguous instant.
const ISO_WITH_OFFSET = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

// A ts outside this window makes every later event of the patient late (future) or reprocesses its
// whole history (far past). Cost: a sender offline for more than 7 days gets 400 for its backlog.
const TS_MAX_AHEAD_MS = 5 * 60_000;
const TS_MAX_BEHIND_MS = 7 * 24 * 60 * 60_000;

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  patientId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  type!: string;

  @IsObject()
  data!: Record<string, unknown>;

  // ts becomes a UTC Date so ordering and dedup compare instants, not strings.
  // C1: we trust the sender's clock; a clock running ahead orders events wrongly.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' &&
    isISO8601(value, { strict: true }) &&
    ISO_WITH_OFFSET.test(value)
      ? new Date(value)
      : value,
  )
  @IsDate({
    message: 'ts must be an ISO 8601 date-time with a timezone offset',
  })
  @MinDate(() => new Date(Date.now() - TS_MAX_BEHIND_MS), {
    message: 'ts must be at most 7 days in the past',
  })
  @MaxDate(() => new Date(Date.now() + TS_MAX_AHEAD_MS), {
    message: 'ts must be at most 5 minutes in the future',
  })
  ts!: Date;
}
