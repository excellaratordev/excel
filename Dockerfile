FROM node:22-alpine AS web-dependencies

WORKDIR /web
COPY package.json ./
RUN npm install --omit=dev
RUN mkdir -p /vendor \
    && cp node_modules/@supabase/supabase-js/dist/umd/supabase.js /vendor/supabase.js

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
COPY --from=web-dependencies /vendor/supabase.js /app/static/vendor/supabase.js

EXPOSE 8000
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT} app:app"]
