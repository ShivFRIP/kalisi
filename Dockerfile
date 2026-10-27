# Single image: builds the three web apps, then serves them and the API from one FastAPI process.
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=web /web/dist /app/frontend/dist
EXPOSE 8000
# Apply migrations, then serve. Two workers; the background simulator/allocation loop runs in only one at a time
# (Postgres advisory lock).
CMD ["sh", "-c", "alembic upgrade head && uvicorn kalisi.main:app --host 0.0.0.0 --port 8000 --workers 2 --proxy-headers"]
