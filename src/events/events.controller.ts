import { Body, Controller, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CreateEventDto } from './dto/create-event.dto';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  async create(
    @Body() dto: CreateEventDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.events.create(dto);
    reply.status(result.duplicate ? 200 : 202);
    return result;
  }
}
