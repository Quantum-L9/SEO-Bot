#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# L9 SEO Bot - Deployment Script for Hetzner CX32
# 
# Prerequisites:
# - Ubuntu 22.04+ VPS with Docker and Docker Compose installed
# - SSH access configured
# - .env file populated with API keys
#
# Usage:
#   ./scripts/deploy.sh [setup|start|stop|restart|logs|status|update|backup]
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[L9 SEO Bot]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ─── Commands ─────────────────────────────────────────────────────────────────

cmd_setup() {
  log "Setting up L9 SEO Bot on Hetzner CX32..."

  # Check Docker
  if ! command -v docker &> /dev/null; then
    log "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    log "Docker installed. Please log out and back in, then re-run setup."
    exit 0
  fi

  # Check Docker Compose
  if ! docker compose version &> /dev/null; then
    error "Docker Compose V2 not found. Install with: sudo apt install docker-compose-plugin"
  fi

  # Check .env
  if [ ! -f "$PROJECT_DIR/.env" ]; then
    warn ".env file not found. Copying from .env.example..."
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    warn "IMPORTANT: Edit .env with your API keys before starting!"
    exit 0
  fi

  # Create data directories
  mkdir -p "$PROJECT_DIR/data/postgres"
  mkdir -p "$PROJECT_DIR/data/redis"
  mkdir -p "$PROJECT_DIR/data/clickhouse"
  mkdir -p "$PROJECT_DIR/data/backups"

  # Build and pull images
  log "Building SEO Bot image..."
  docker compose -f "$COMPOSE_FILE" build

  log "Pulling PostHog and dependency images..."
  docker compose -f "$COMPOSE_FILE" pull

  # Run database migrations
  log "Running database migrations..."
  docker compose -f "$COMPOSE_FILE" run --rm l9-seo-bot pnpm migrate

  log "Setup complete! Run './scripts/deploy.sh start' to launch."
}

cmd_start() {
  log "Starting L9 SEO Bot stack..."
  docker compose -f "$COMPOSE_FILE" up -d
  log "Stack started. Checking health..."
  sleep 10
  cmd_status
}

cmd_stop() {
  log "Stopping L9 SEO Bot stack..."
  docker compose -f "$COMPOSE_FILE" down
  log "Stack stopped."
}

cmd_restart() {
  log "Restarting L9 SEO Bot stack..."
  docker compose -f "$COMPOSE_FILE" restart
  log "Stack restarted."
}

cmd_logs() {
  local service="${2:-l9-seo-bot}"
  docker compose -f "$COMPOSE_FILE" logs -f --tail=100 "$service"
}

cmd_status() {
  log "Stack status:"
  docker compose -f "$COMPOSE_FILE" ps
  echo ""
  log "Health check:"
  curl -s http://localhost:3100/health | python3 -m json.tool 2>/dev/null || warn "Bot not responding yet"
  echo ""
  log "PostHog:"
  curl -s http://localhost:8000/_health | head -1 || warn "PostHog not responding yet"
}

cmd_update() {
  log "Updating L9 SEO Bot..."
  git pull origin main 2>/dev/null || true
  docker compose -f "$COMPOSE_FILE" build l9-seo-bot
  docker compose -f "$COMPOSE_FILE" up -d l9-seo-bot
  log "Bot updated and restarted."
}

cmd_backup() {
  local backup_dir="$PROJECT_DIR/data/backups"
  local timestamp=$(date +%Y%m%d_%H%M%S)
  local backup_file="$backup_dir/l9_seo_bot_$timestamp.sql.gz"

  log "Backing up database to $backup_file..."
  docker compose -f "$COMPOSE_FILE" exec -T postgres pg_dumpall -U l9bot | gzip > "$backup_file"
  log "Backup complete: $backup_file ($(du -h "$backup_file" | cut -f1))"

  # Keep only last 7 backups
  ls -t "$backup_dir"/l9_seo_bot_*.sql.gz | tail -n +8 | xargs -r rm
  log "Old backups cleaned (keeping last 7)."
}

# ─── Main ─────────────────────────────────────────────────────────────────────

case "${1:-help}" in
  setup)   cmd_setup ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  logs)    cmd_logs "$@" ;;
  status)  cmd_status ;;
  update)  cmd_update ;;
  backup)  cmd_backup ;;
  *)
    echo "L9 SEO Bot - Deployment Manager"
    echo ""
    echo "Usage: $0 {setup|start|stop|restart|logs|status|update|backup}"
    echo ""
    echo "Commands:"
    echo "  setup    - First-time setup (Docker, images, migrations)"
    echo "  start    - Start all services"
    echo "  stop     - Stop all services"
    echo "  restart  - Restart all services"
    echo "  logs     - View logs (default: l9-seo-bot, or specify service)"
    echo "  status   - Show service status and health"
    echo "  update   - Pull latest code and rebuild bot"
    echo "  backup   - Backup PostgreSQL database"
    ;;
esac
