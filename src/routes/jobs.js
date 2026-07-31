const express = require("express");
const multer = require("multer");
const path = require("path");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (_req, file, cb) => {
    cb(null, `resume-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ".pdf"}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["application/pdf", "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    if (ok.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Resumes must be a PDF or Word document."));
  },
});

const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP", "TEMPORARY", "VOLUNTEER"];
const ARRANGEMENTS = ["ONSITE", "HYBRID", "REMOTE"];
const APP_STATUSES = ["SUBMITTED", "REVIEWING", "INTERVIEWING", "OFFERED", "REJECTED", "WITHDRAWN"];

const posterSelect = { select: { id: true, username: true, displayName: true, avatarUrl: true } };

function serializeJob(job, viewerId) {
  return {
    id: job.id,
    title: job.title,
    companyName: job.companyName,
    companyLogoUrl: job.companyLogoUrl,
    description: job.description,
    responsibilities: job.responsibilities,
    requirements: job.requirements,
    location: job.location,
    arrangement: job.arrangement,
    employmentType: job.employmentType,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    salaryPeriod: job.salaryPeriod,
    applyUrl: job.applyUrl,
    status: job.status,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    poster: job.poster,
    applicationCount: job._count?.applications ?? 0,
    isOwner: viewerId === job.posterId,
    appliedByViewer: (job.applications || []).some((a) => a.applicantId === viewerId),
  };
}

// --- Browse / search -----------------------------------------------------
router.get("/", optionalAuth, async (req, res) => {
  const { q, arrangement, employmentType, minSalary, location } = req.query;

  const jobs = await prisma.jobPosting.findMany({
    where: {
      status: "OPEN",
      // Expired postings drop out automatically rather than lingering.
      OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }],
      ...(q && {
        AND: [{
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { companyName: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
          ],
        }],
      }),
      ...(ARRANGEMENTS.includes(arrangement) && { arrangement }),
      ...(EMPLOYMENT_TYPES.includes(employmentType) && { employmentType }),
      ...(location && { location: { contains: location, mode: "insensitive" } }),
      ...(minSalary && { salaryMax: { gte: Number(minSalary) } }),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      poster: posterSelect,
      _count: { select: { applications: true } },
      ...(req.userId && { applications: { where: { applicantId: req.userId }, select: { applicantId: true } } }),
    },
  });

  res.json({ jobs: jobs.map((j) => serializeJob(j, req.userId)) });
});

router.get("/mine", requireAuth, async (req, res) => {
  const jobs = await prisma.jobPosting.findMany({
    where: { posterId: req.userId },
    orderBy: { createdAt: "desc" },
    include: { poster: posterSelect, _count: { select: { applications: true } } },
  });
  res.json({ jobs: jobs.map((j) => serializeJob(j, req.userId)) });
});

// Applications the CURRENT USER has submitted.
router.get("/applications/mine", requireAuth, async (req, res) => {
  const applications = await prisma.jobApplication.findMany({
    where: { applicantId: req.userId },
    orderBy: { createdAt: "desc" },
    include: { job: { include: { poster: posterSelect } } },
  });
  // employerNote is deliberately excluded -- it's the employer's private
  // working note, not something the candidate should see.
  res.json({
    applications: applications.map((a) => ({
      id: a.id,
      status: a.status,
      coverLetter: a.coverLetter,
      resumeUrl: a.resumeUrl,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      job: {
        id: a.job.id, title: a.job.title, companyName: a.job.companyName,
        location: a.job.location, arrangement: a.job.arrangement, status: a.job.status,
      },
    })),
  });
});

router.get("/:id", optionalAuth, async (req, res) => {
  const job = await prisma.jobPosting.findUnique({
    where: { id: req.params.id },
    include: {
      poster: posterSelect,
      _count: { select: { applications: true } },
      ...(req.userId && { applications: { where: { applicantId: req.userId }, select: { applicantId: true } } }),
    },
  });
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json({ job: serializeJob(job, req.userId) });
});

// --- Post a job ----------------------------------------------------------
router.post("/", requireAuth, upload.single("logo"), async (req, res) => {
  const {
    title, companyName, description, responsibilities, requirements, location,
    arrangement, employmentType, salaryMin, salaryMax, salaryCurrency, salaryPeriod,
    applyUrl, expiresAt,
  } = req.body || {};

  if (!title || !companyName || !description) {
    return res.status(400).json({ error: "Job title, company name, and description are required." });
  }

  const min = salaryMin ? Math.round(Number(salaryMin)) : null;
  const max = salaryMax ? Math.round(Number(salaryMax)) : null;
  if (min != null && max != null && min > max) {
    return res.status(400).json({ error: "The minimum salary can't be higher than the maximum." });
  }

  const job = await prisma.jobPosting.create({
    data: {
      posterId: req.userId,
      title,
      companyName,
      description,
      responsibilities: responsibilities || null,
      requirements: requirements || null,
      location: location || null,
      arrangement: ARRANGEMENTS.includes(arrangement) ? arrangement : "ONSITE",
      employmentType: EMPLOYMENT_TYPES.includes(employmentType) ? employmentType : "FULL_TIME",
      salaryMin: min,
      salaryMax: max,
      salaryCurrency: salaryCurrency || "USD",
      salaryPeriod: salaryPeriod || "YEAR",
      applyUrl: applyUrl || null,
      companyLogoUrl: req.file ? `/uploads/${req.file.filename}` : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    },
    include: { poster: posterSelect, _count: { select: { applications: true } } },
  });

  res.status(201).json({ job: serializeJob(job, req.userId) });
});

router.patch("/:id", requireAuth, async (req, res) => {
  const job = await prisma.jobPosting.findUnique({ where: { id: req.params.id } });
  if (!job || job.posterId !== req.userId) return res.status(404).json({ error: "Job not found." });

  const { status, title, description, salaryMin, salaryMax, location } = req.body || {};
  const updated = await prisma.jobPosting.update({
    where: { id: job.id },
    data: {
      ...(status && ["OPEN", "CLOSED", "FILLED"].includes(status) && { status }),
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(salaryMin !== undefined && { salaryMin: salaryMin ? Math.round(Number(salaryMin)) : null }),
      ...(salaryMax !== undefined && { salaryMax: salaryMax ? Math.round(Number(salaryMax)) : null }),
      ...(location !== undefined && { location: location || null }),
    },
    include: { poster: posterSelect, _count: { select: { applications: true } } },
  });
  res.json({ job: serializeJob(updated, req.userId) });
});

router.delete("/:id", requireAuth, async (req, res) => {
  const job = await prisma.jobPosting.findUnique({ where: { id: req.params.id } });
  if (!job || job.posterId !== req.userId) return res.status(404).json({ error: "Job not found." });
  await prisma.jobPosting.delete({ where: { id: job.id } });
  res.status(204).end();
});

// --- Apply ---------------------------------------------------------------
router.post("/:id/apply", requireAuth, upload.single("resume"), async (req, res) => {
  const job = await prisma.jobPosting.findUnique({ where: { id: req.params.id } });
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status !== "OPEN") return res.status(409).json({ error: "This job is no longer accepting applications." });
  if (job.posterId === req.userId) return res.status(400).json({ error: "You can't apply to your own posting." });

  const existing = await prisma.jobApplication.findUnique({
    where: { jobId_applicantId: { jobId: job.id, applicantId: req.userId } },
  });
  if (existing) return res.status(409).json({ error: "You've already applied to this job." });

  const { coverLetter } = req.body || {};
  const application = await prisma.jobApplication.create({
    data: {
      jobId: job.id,
      applicantId: req.userId,
      coverLetter: coverLetter || null,
      resumeUrl: req.file ? `/uploads/${req.file.filename}` : null,
    },
  });
  res.status(201).json({ application });
});

// Applicants for a job -- employer only.
router.get("/:id/applications", requireAuth, async (req, res) => {
  const job = await prisma.jobPosting.findUnique({ where: { id: req.params.id } });
  if (!job || job.posterId !== req.userId) return res.status(404).json({ error: "Job not found." });

  const applications = await prisma.jobApplication.findMany({
    where: { jobId: job.id },
    orderBy: { createdAt: "desc" },
    include: {
      applicant: {
        select: {
          id: true, username: true, displayName: true, avatarUrl: true,
          bio: true, occupation: true, education: true, city: true, country: true,
        },
      },
    },
  });
  res.json({ applications });
});

router.patch("/applications/:applicationId", requireAuth, async (req, res) => {
  const application = await prisma.jobApplication.findUnique({
    where: { id: req.params.applicationId },
    include: { job: true },
  });
  if (!application) return res.status(404).json({ error: "Application not found." });

  const isEmployer = application.job.posterId === req.userId;
  const isApplicant = application.applicantId === req.userId;
  if (!isEmployer && !isApplicant) return res.status(404).json({ error: "Application not found." });

  const { status, employerNote } = req.body || {};

  // An applicant can only withdraw; they can't move themselves to
  // "OFFERED". Only the employer moves an application through the pipeline.
  if (isApplicant && !isEmployer) {
    if (status !== "WITHDRAWN") {
      return res.status(403).json({ error: "You can withdraw your application, but only the employer can change its stage." });
    }
    const updated = await prisma.jobApplication.update({
      where: { id: application.id },
      data: { status: "WITHDRAWN" },
    });
    return res.json({ application: updated });
  }

  const updated = await prisma.jobApplication.update({
    where: { id: application.id },
    data: {
      ...(status && APP_STATUSES.includes(status) && { status }),
      ...(employerNote !== undefined && { employerNote: employerNote || null }),
    },
  });
  res.json({ application: updated });
});

module.exports = router;
