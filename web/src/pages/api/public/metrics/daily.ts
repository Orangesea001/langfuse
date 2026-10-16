// Disabled: daily metrics API removed for internal deployment (not needed).
import { NextApiRequest, NextApiResponse } from "next";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(410).json({ error: "This endpoint has been disabled." });
}
