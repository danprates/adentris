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
}

export type EventDocument = HydratedDocument<Event>;

export const EventSchema = SchemaFactory.createForClass(Event);

EventSchema.index({ dedupKey: 1 }, { unique: true });
// The database itself forbids two events of the same patient in processing at once.
EventSchema.index(
  { patientId: 1 },
  { unique: true, partialFilterExpression: { status: 'processing' } },
);
EventSchema.index({ status: 1, availableAt: 1, ts: 1 });
EventSchema.index({ patientId: 1, status: 1, ts: 1 });
