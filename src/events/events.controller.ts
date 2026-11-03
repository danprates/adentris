import { Controller, HttpCode, Post } from '@nestjs/common';

@Controller('events')
export class EventsController {
  @Post()
  @HttpCode(200)
  create() {
    return { status: 'ok' };
  }
}
