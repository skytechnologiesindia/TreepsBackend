import { Module } from "@nestjs/common"
import { DriverDocumentsController } from "./driver-documents.controller.js"
import { DriverDocumentService } from "./driver-documents.service.js"
import { DriverOnboardingController } from "./driver-onboarding.controller.js"
import { DriverOnboardingService } from "./driver-onboarding.service.js"
import { OtpModule } from "../otp/otp.module.js"
import { SessionModule } from "../../common/session/session.module.js"
import { StorageModule } from "../../common/storage/storage.module.js"


@Module({
    imports: [OtpModule, SessionModule, StorageModule],
    controllers: [DriverDocumentsController, DriverOnboardingController],
    providers : [DriverDocumentService, DriverOnboardingService]
})

export class DriverDocumentModule{}
