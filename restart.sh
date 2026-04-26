#!/bin/bash
set -e

cd /home/taha/.openclaw/workspace/doc-indexer

echo "Stopping and removing containers..."
docker compose down --remove-orphans

echo "Removing old containers..."
docker rm -f dockhoj-app dockhoj-qdrant dockhoj-ollama 2>/dev/null || true

echo "Removing old images..."
docker rmi dockhoj-app doc-khoj-app doc-indexer-app 2>/dev/null || true

echo "Building new image (includes public/ folder)..."
docker compose build --no-cache

echo "Starting containers..."
docker compose up -d

echo "Waiting for app to be healthy..."
sleep 3

for i in {1..10}; do
    if curl -s http://localhost:3001/health > /dev/null 2>&1; then
        echo "App is healthy!"
        exit 0
    fi
    echo "Waiting... ($i/10)"
    sleep 2
done

echo "App failed to become healthy. Check logs:"
docker logs dockhoj-app --tail 20
exit 1