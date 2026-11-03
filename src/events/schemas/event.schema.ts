import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';

export const EVENT_STATUSES = [
  'pending',
  'processing',
  'done',
  'failed',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

// minimize: false keeps an empty `data: {}` instead of dropping the field.
@Schema({ collection: 'events', versionKey: false, minimize: false })
export class Event {
  @Prop({ required: true })
  dedupKey: string;

  @Prop({ required: true })
  patientId: string;

  @Prop({ required: true })
  type: string;

  @Prop({ type: SchemaTypes.Mixed, required: true })
  data: Record<string, unknown>;

  @Prop({ required: true })
  ts: Date;

  @Prop({ required: true })
  receivedAt: Date;

  @Prop({ type: String, enum: EVENT_STATUSES, default: 'pending' })
  status: EventStatus;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ required: true })
  availableAt: Date;

  @Prop()
  leaseOwner?: string;

  @Prop()
  leaseUntil?: Date;

  @Prop({ type: SchemaTypes.Mixed })
  result?: Record<string, unknown>;

  @Prop()
  processedAt?: Date;

  @Prop({ default: 0 })
  reprocessCount: number;
}

export type EventDocument = HydratedDocument<Event>;

export const EventSchema = SchemaFactory.createForClass(Event);

EventSchema.index({ dedupKey: 1 }, { unique: true });
// The database guarantees one event per patient in processing.
// Cost: at most 12 events/min per patient (5s each), across all types.
EventSchema.index(
  { patientId: 1 },
  { unique: true, partialFilterExpression: { status: 'processing' } },
);
EventSchema.index({ status: 1, availableAt: 1, ts: 1 });
EventSchema.index({ patientId: 1, status: 1, ts: 1 });
