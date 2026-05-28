FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Project layout: docker build context is the blueeye-server repo root so the
# License Server can be packaged with its own subdirectory pythonpath.
COPY license_server/requirements.txt ./license_server/requirements.txt
RUN pip install -r license_server/requirements.txt

COPY license_server ./license_server

EXPOSE 8001

CMD ["uvicorn", "license_server.app.main:app", "--host", "0.0.0.0", "--port", "8001"]
