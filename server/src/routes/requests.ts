import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../middleware/requireAuth.js";
import type { ProcurementAgent } from "../services/procurementAgent.js";
import type { RequestService } from "../services/requestService.js";
import { MAX_ITEMS_PER_VERSION } from "../services/requestService.js";

const quantity = z.number().int().min(1).max(1000);
const revision = z.number().int().min(0);
const itemInput = z.object({
  channel3ProductId: z.string().trim().min(1).max(100),
  quantity,
  rationale: z.string().trim().max(1000).optional(),
});

const createRequestBody = z.object({
  prompt: z.string().trim().min(3).max(4000),
  budgetCents: z.number().int().min(1).max(100_000_000).optional(),
});
const createVersionBody = z.object({
  basedOnVersion: z.number().int().min(1).optional(),
  summary: z.string().trim().max(2000).optional(),
  instruction: z.string().trim().max(2000).optional(),
  items: z.array(itemInput).min(1).max(MAX_ITEMS_PER_VERSION),
});
const versionParams = z.object({ id: z.string(), n: z.coerce.number().int().min(1) });
const itemParams = versionParams.extend({ itemId: z.string() });

const copyVersionBody = z.object({
  summary: z.string().trim().max(200).optional(),
  expectedLatestVersion: z.number().int().min(0),
});

const generateBody = z.object({
  instruction: z.string().trim().min(2).max(500).optional(),
  expectedLatestVersion: z.number().int().min(0),
});

const sharesBody = z.object({
  shares: z.array(z.object({ userId: z.string(), amountCents: z.number().int().min(1) })).min(1).max(10),
});
const inviteParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{10,64}$/) });

export function createRequestsRouter(jwtSecret: string, service: RequestService, agent: ProcurementAgent) {
  const router = Router();
  router.use(requireAuth(jwtSecret));

  router.post("/", async (req, res) => {
    res.status(201).json({ request: await service.createRequest(currentUserId(res), createRequestBody.parse(req.body)) });
  });

  router.get("/invites/:token", async (req, res) => {
    const { token } = inviteParams.parse(req.params);
    res.json({ invite: await service.previewInvite(currentUserId(res), token) });
  });

  router.post("/invites/:token/join", async (req, res) => {
    const { token } = inviteParams.parse(req.params);
    res.json(await service.joinByInvite(currentUserId(res), token));
  });

  router.get("/", async (_req, res) => {
    res.json({ requests: await service.listRequests(currentUserId(res)) });
  });

  router.get("/:id", async (req, res) => {
    res.json(await service.getRequest(currentUserId(res), req.params.id));
  });

  router.delete("/:id", async (req, res) => {
    await service.deleteRequest(currentUserId(res), req.params.id);
    res.status(204).end();
  });

  router.post("/:id/versions", async (req, res) => {
    const body = createVersionBody.parse(req.body);
    res.status(201).json({ version: await service.createVersion(currentUserId(res), req.params.id, body) });
  });

  router.post("/:id/generate", async (req, res) => {
    const body = generateBody.parse(req.body);
    res.status(201).json(await agent.generate(currentUserId(res), req.params.id, body));
  });

  router.get("/:id/versions", async (req, res) => {
    res.json({ versions: await service.listVersions(currentUserId(res), req.params.id) });
  });

  router.post("/:id/versions/:n/copy", async (req, res) => {
    const { id, n } = versionParams.parse(req.params);
    const body = copyVersionBody.parse(req.body);
    res.status(201).json({ version: await service.copyVersion(currentUserId(res), id, n, body) });
  });

  router.get("/:id/versions/:n", async (req, res) => {
    const { id, n } = versionParams.parse(req.params);
    res.json({ version: await service.getVersion(currentUserId(res), id, n) });
  });

  router.post("/:id/versions/:n/approve", async (req, res) => {
    const { id, n } = versionParams.parse(req.params);
    const { expectedRevision } = z.object({ expectedRevision: revision }).parse(req.body);
    res.json(await service.approveVersion(currentUserId(res), id, n, expectedRevision));
  });

  router.delete("/:id/versions/:n/nod", async (req, res) => {
    const { id, n } = versionParams.parse(req.params);
    res.json({ version: await service.withdrawNod(currentUserId(res), id, n) });
  });

  router.post("/:id/invite", async (req, res) => {
    res.status(201).json(await service.createInvite(currentUserId(res), req.params.id));
  });

  router.delete("/:id/invite", async (req, res) => {
    await service.revokeInvite(currentUserId(res), req.params.id);
    res.status(204).end();
  });

  router.delete("/:id/members/:userId", async (req, res) => {
    await service.removeMember(currentUserId(res), req.params.id, req.params.userId);
    res.status(204).end();
  });

  router.put("/:id/shares", async (req, res) => {
    res.json(await service.setShares(currentUserId(res), req.params.id, sharesBody.parse(req.body).shares));
  });

  router.post("/:id/unapprove", async (req, res) => {
    res.json(await service.unapprove(currentUserId(res), req.params.id));
  });

  router.get("/:id/versions/:n/diff", async (req, res) => {
    const { id, n } = versionParams.parse(req.params);
    const { against } = z.object({ against: z.coerce.number().int().min(1) }).parse(req.query);
    res.json({ diff: await service.diffVersions(currentUserId(res), id, n, against) });
  });

  router.post("/:id/versions/:n/items", async (req, res) => {
    const { id, n } = versionParams.parse(req.params);
    const { expectedRevision, ...item } = itemInput.extend({ expectedRevision: revision }).parse(req.body);
    res.status(201).json({ version: await service.addItem(currentUserId(res), id, n, item, expectedRevision) });
  });

  router.patch("/:id/versions/:n/items/:itemId", async (req, res) => {
    const { id, n, itemId } = itemParams.parse(req.params);
    const body = z.object({ quantity, expectedRevision: revision }).parse(req.body);
    res.json({
      version: await service.updateItemQuantity(currentUserId(res), id, n, itemId, body.quantity, body.expectedRevision),
    });
  });

  router.delete("/:id/versions/:n/items/:itemId", async (req, res) => {
    const { id, n, itemId } = itemParams.parse(req.params);
    const { expectedRevision } = z.object({ expectedRevision: z.coerce.number().int().min(0) }).parse(req.query);
    res.json({ version: await service.removeItem(currentUserId(res), id, n, itemId, expectedRevision) });
  });

  return router;
}
