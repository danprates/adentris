import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { CreateEventDto } from './dto/create-event.dto';

@Controller('events')
export class EventsController {
  @Post()
  @HttpCode(200)
  create(@Body() dto: CreateEventDto) {
    return { patientId: dto.patientId, status: 'ok' };
  }
}
