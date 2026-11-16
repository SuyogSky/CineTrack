import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('Multi-User Collaboration Integration Tests', () => {
  let ownerCookie: string[];
  let collaboratorCookie: string[];
  let outsiderCookie: string[];
  let collectionId: string;

  beforeEach(async () => {
    // 1. Owner
    const ownerRes = await request(app).post('/api/auth/register').send({
      username: 'carol',
      email: 'carol@example.com',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    });
    ownerCookie = ownerRes.headers['set-cookie'] as unknown as string[];

    // 2. Collaborator
    const collabRes = await request(app).post('/api/auth/register').send({
      username: 'dave',
      email: 'dave@example.com',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    });
    collaboratorCookie = collabRes.headers['set-cookie'] as unknown as string[];

    // 3. Outsider
    const outsiderRes = await request(app).post('/api/auth/register').send({
      username: 'eve',
      email: 'eve@example.com',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    });
    outsiderCookie = outsiderRes.headers['set-cookie'] as unknown as string[];

    // Create collection owned by carol
    const colRes = await request(app)
      .post('/api/collections')
      .set('Cookie', ownerCookie)
      .send({ title: 'Shared Movie Club' });
    collectionId = colRes.body.data.collection.id;
  });

  it('should complete the invitation, acceptance, and shared management lifecycle', async () => {
    // 1. Carol invites Dave
    const inviteRes = await request(app)
      .post(`/api/collections/${collectionId}/invitations`)
      .set('Cookie', ownerCookie)
      .send({ usernameOrEmail: 'dave' });

    expect(inviteRes.status).toBe(201);
    const invitationId = inviteRes.body.data.invitation.id;

    // 2. Dave checks pending invitations
    const daveInvites = await request(app)
      .get('/api/invitations')
      .set('Cookie', collaboratorCookie);
    expect(daveInvites.status).toBe(200);
    expect(daveInvites.body.data.invitations.length).toBe(1);
    expect(daveInvites.body.data.invitations[0].id).toBe(invitationId);

    // 3. Eve attempts to accept Dave's invitation -> Must be Forbidden
    const fraudAccept = await request(app)
      .post(`/api/invitations/${invitationId}/accept`)
      .set('Cookie', outsiderCookie);
    expect(fraudAccept.status).toBe(403);

    // 4. Dave accepts his invitation
    const acceptRes = await request(app)
      .post(`/api/invitations/${invitationId}/accept`)
      .set('Cookie', collaboratorCookie);
    expect(acceptRes.status).toBe(200);

    // 5. Dave can view the collection
    const getCol = await request(app)
      .get(`/api/collections/${collectionId}`)
      .set('Cookie', collaboratorCookie);
    expect(getCol.status).toBe(200);
    expect(getCol.body.data.collection.userRole).toBe('COLLABORATOR');

    // 6. Dave adds a movie (Pulp Fiction tmdbId: 680)
    const addMovieRes = await request(app)
      .post(`/api/collections/${collectionId}/movies`)
      .set('Cookie', collaboratorCookie)
      .send({ tmdbId: 680, note: 'Added by Dave' });
    expect(addMovieRes.status).toBe(201);

    // 7. Dave attempts to delete the collection -> Must be Forbidden
    const deleteColRes = await request(app)
      .delete(`/api/collections/${collectionId}`)
      .set('Cookie', collaboratorCookie);
    expect(deleteColRes.status).toBe(403);

    // 8. Dave attempts to invite Eve -> Must be Forbidden (only owner can invite)
    const collabInviteRes = await request(app)
      .post(`/api/collections/${collectionId}/invitations`)
      .set('Cookie', collaboratorCookie)
      .send({ usernameOrEmail: 'eve' });
    expect(collabInviteRes.status).toBe(403);
  });

  it('should immediately revoke collaborator access when owner removes them', async () => {
    // Invite and accept
    const inviteRes = await request(app)
      .post(`/api/collections/${collectionId}/invitations`)
      .set('Cookie', ownerCookie)
      .send({ usernameOrEmail: 'dave' });
    const invitationId = inviteRes.body.data.invitation.id;

    await request(app)
      .post(`/api/invitations/${invitationId}/accept`)
      .set('Cookie', collaboratorCookie);

    // Get Dave's user ID
    const membersRes = await request(app)
      .get(`/api/collections/${collectionId}/members`)
      .set('Cookie', ownerCookie);
    const daveId = membersRes.body.data.members[0].userId;

    // Carol removes Dave
    const removeRes = await request(app)
      .delete(`/api/collections/${collectionId}/members/${daveId}`)
      .set('Cookie', ownerCookie);
    expect(removeRes.status).toBe(200);

    // Dave attempts to access the collection again -> Must be Forbidden
    const postRemovalGet = await request(app)
      .get(`/api/collections/${collectionId}`)
      .set('Cookie', collaboratorCookie);
    expect(postRemovalGet.status).toBe(403);
  });
});
