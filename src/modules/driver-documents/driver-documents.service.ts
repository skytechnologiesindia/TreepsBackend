import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service.js";
import { STEP_RULES, type StepKey } from "./onboarding-rules.js";

// The order of the rows on the app screen. A key that is not in this list goes to the end.
const STEP_ORDER = [
    "VEHICLE",
    "PERSONAL_INFO",
    "PERSONAL_IDENTITY",
    "DRIVING_LICENCE",
    "VEHICLE_NUMBER",
    "PERMIT",
    "CAB_INSURANCE",
    "FITNESS",
];

export type OptionStatus = "AVAILABLE" | "COMING_SOON";

function position(key: string): number {
    const index = STEP_ORDER.indexOf(key);
    return index === -1 ? STEP_ORDER.length : index;
}

// Each option the server knows for this step, in its fixed order, with its status. An option in
// neither column is hidden; one in both counts as available; a value the server does not know is ignored.
function optionsOf(type: string, available: string[], comingSoon: string[]) {
    const known = STEP_RULES[type as StepKey]?.options ?? [];
    return known
        .filter((value) => available.includes(value) || comingSoon.includes(value))
        .map((value) => ({ value, status: (available.includes(value) ? "AVAILABLE" : "COMING_SOON") as OptionStatus }));
}

// GET /v1/driver/documents/requirements (docs/api/driver/driver-document-requirements.md).
@Injectable()
export class DriverDocumentService{
    constructor(private readonly prisma: PrismaService) {}

    async getRequirements() {
        const rows = await this.prisma.documentRequirement.findMany({
            where: { enabled: true },
            select: { type: true, required: true, options: true, comingSoonOptions: true },
        });
        const steps = rows
            .sort((a, b) => position(a.type) - position(b.type) || a.type.localeCompare(b.type))
            .map((row) => {
                const options = optionsOf(row.type, row.options, row.comingSoonOptions);
                // Only steps that have choices send "options".
                return { key: row.type, required: row.required, ...(options.length > 0 ? { options } : {}) };
            });
        return { steps };
    }
}
