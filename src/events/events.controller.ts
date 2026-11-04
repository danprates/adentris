import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { WideEventRequest } from '../common/wide-event.interceptor';
import { CreateEventDto } from './dto/create-event.dto';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  async create(
    @Body() dto: CreateEventDto,
    @Req() req: WideEventRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { id, status, duplicate, dedupKey } = await this.events.create(dto);
    req.wideEvent = { eventId: id, dedupKey, duplicate };
    // 202 once the event is stored; a worker processes it later, so the sender never waits for the ~5s call.
    // Cost: 202 means stored, not processed.
    reply.status(duplicate ? 200 : 202);
    return { id, status };
  }
}
