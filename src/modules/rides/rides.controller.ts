import { Controller, Body, Post, HttpCode } from '@nestjs/common';
import { RidesService } from './rides.service.js';
import { EstimateDto } from './dto/estimate.dto.js';

@Controller('rides')
export class RidesController {
  constructor(private readonly ridesService: RidesService) {}

  @HttpCode(200)
  @Post('estimate')
  estimate(@Body() dto: EstimateDto) {
    return this.ridesService.estimate(dto);
  }

}
