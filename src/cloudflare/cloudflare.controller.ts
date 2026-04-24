import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { CloudflareService } from './cloudflare.service';
import { CreateCloudflareDto } from './dto/create-cloudflare.dto';
import { UpdateCloudflareDto } from './dto/update-cloudflare.dto';

@Controller('cloudflare')
export class CloudflareController {
  constructor(private readonly cloudflareService: CloudflareService) {}

  // @Post()
  // create(@Body() createCloudflareDto: CreateCloudflareDto) {
  //   return this.cloudflareService.create(createCloudflareDto);
  // }

  // @Get()
  // findAll() {
  //   return this.cloudflareService.findAll();
  // }

  // @Get(':id')
  // findOne(@Param('id') id: string) {
  //   return this.cloudflareService.findOne(+id);
  // }

  // @Patch(':id')
  // update(@Param('id') id: string, @Body() updateCloudflareDto: UpdateCloudflareDto) {
  //   return this.cloudflareService.update(+id, updateCloudflareDto);
  // }

  // @Delete(':id')
  // remove(@Param('id') id: string) {
  //   return this.cloudflareService.remove(+id);
  // }
}
