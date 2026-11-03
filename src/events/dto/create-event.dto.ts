import { Transform } from 'class-transformer';
import {
  IsDate,
  IsNotEmpty,
  IsObject,
  IsString,
  isISO8601,
} from 'class-validator';

// Only a full ISO 8601 date-time with an explicit offset is a single, unambiguous instant.
const ISO_WITH_OFFSET = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  patientId: string;

  @IsString()
  @IsNotEmpty()
  type: string;

  @IsObject()
  data: Record<string, unknown>;

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
  ts: Date;
}
