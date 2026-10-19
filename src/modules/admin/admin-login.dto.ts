import { Email, Normalize, Required, Text } from '../../common/validation/fields.js';

// docs/api/admin/admin-login.md. The password is not trimmed or changed in any way.
export class AdminLoginDto {
  @Normalize({ lower: true, blank: 'unset' }) @Required(Email()) email!: string;
  @Required(Text({ min: 1, max: 128 })) password!: string;
}
