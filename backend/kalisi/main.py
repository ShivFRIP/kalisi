"""Kalisi API. Run: uvicorn kalisi.main:app --reload  (see README)."""
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .api import auth, driver, ops, public, rider
from .config import DEV_JWT_SECRET, get_settings
from .db import SessionLocal
from .services import simulator

log = logging.getLogger("kalisi")
FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "dist"


def _tick() -> None:
    db = SessionLocal()
    try:
        simulator.tick(db)
    except Exception:
        db.rollback()
        log.exception("background tick failed")
    finally:
        db.close()


async def _loop() -> None:
    while True:
        await run_in_threadpool(_tick)
        await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    if not s.is_dev and (s.jwt_secret == DEV_JWT_SECRET or len(s.jwt_secret) < 32):
        raise RuntimeError("Set KALISI_JWT_SECRET to a long random value before running with KALISI_ENV=prod")
    task = asyncio.create_task(_loop()) if s.background_jobs else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="Kalisi API", version="0.1.0", lifespan=lifespan,
              description="Office-commute shuttle platform for Hyderabad: working prototype.")
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()],
                   allow_methods=["*"], allow_headers=["*"])
for r in (auth.router, rider.router, driver.router, ops.router, public.router):
    app.include_router(r, prefix="/api/v1")

if FRONTEND.exists():  # serve the built web apps from the same process (single-server deploys)
    app.mount("/assets", StaticFiles(directory=FRONTEND / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        f = FRONTEND / path
        if path and f.is_file() and FRONTEND in f.resolve().parents:
            return FileResponse(f)
        return FileResponse(FRONTEND / "index.html")
