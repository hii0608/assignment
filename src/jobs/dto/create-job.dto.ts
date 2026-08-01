import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreateJobDto {
  @IsString()
  @Length(1, 100)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
