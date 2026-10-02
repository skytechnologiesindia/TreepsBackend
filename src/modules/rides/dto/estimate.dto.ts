import { Latitude, Longitude, Text, Required } from "../../../common/validation/fields.js";


export class EstimateDto {
    @Required(Latitude()) pickupLat!: number;
    @Required(Longitude()) pickupLng! : number;
    @Required(Latitude()) dropLat! : number;
    @Required(Longitude()) dropLng!: number
    @Required(Text({min: 1, max : 200})) pickupAddress! : string;
    @Required(Text({min: 1, max : 200})) dropAddress! : string;
}