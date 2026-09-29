# Treeps Backend Agent Instruction & Guidelines

## 1. Project Overview & Architecture
- **Project Name:** Treeps MVP Backend
- **Architecture:** Modular Monolith (Node.js / NestJS with TypeScript) inside a single unified repository/server.
- **Core Principle:** Clean separation of concerns (Modules, Controllers, Services, DTOs). Every business domain lives in its own isolated module under `src/modules/`.

## 2. Core Working Style & Rules for the Agent
- **No Massive Code Dumps:** Build feature by feature, step-by-step. Explain the system design concept *before* writing code.
- **Beginner-Friendly with Best Practices:** The user is learning system design alongside implementation. Explain *why* a pattern is used (e.g., DTO validation, JWT guards, single-use OTPs) and enforce industry best practices.
- **Parallel Admin Visibility (Crucial):** Do not wait until the end to build administrative capabilities. Every major user-facing domain (Riders, Drivers, Rides) must include corresponding **Admin audit / tracking / metrics endpoints** from day one so the developer can monitor activity live during local development.
- **Strict Adherence to PRD:** Follow the functional requirements (FRs) and non-functional requirements (NFRs) outlined in the product requirements document (Authentication, Subscriptions, Geo-matching, Trip execution, Direct payments).


## 3. Current Milestone
- **Phase:** Initial Setup & Authentication Module (Rider Phone OTP + Google Auth + Admin Audit baseline).
- **Next Task:** Establish the PostgreSQL database configuration and build out the Rider Phone OTP and initial Admin tracking metrics route.