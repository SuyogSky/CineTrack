import { z } from 'zod';

export const inviteCollaboratorSchema = z.object({
  usernameOrEmail: z
    .string()
    .trim()
    .min(1, 'Username or email is required')
    .max(100),
});

export type InviteCollaboratorInput = z.infer<typeof inviteCollaboratorSchema>;
