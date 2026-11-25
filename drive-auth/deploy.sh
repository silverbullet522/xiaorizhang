#!/usr/bin/env bash
set -euo pipefail

project_ref=${1:?Usage: bash drive-auth/deploy.sh GOOGLE_CLOUD_PROJECT_ID_OR_NUMBER}
read -r project project_number <<< "$(gcloud projects describe "$project_ref" --format='value(projectId,projectNumber)')"
if [[ -z "$project" || ! "$project_number" =~ ^[0-9]+$ ]]; then
  echo '无法读取 Google Cloud 项目。' >&2
  exit 1
fi
region=${DRIVE_AUTH_REGION:-asia-northeast1}
service=xiaorizhang-drive-auth
runtime_name=hiba-drive-auth
build_name=hiba-drive-build
runtime="$runtime_name@$project.iam.gserviceaccount.com"
builder="$build_name@$project.iam.gserviceaccount.com"
url="https://$service-$project_number.$region.run.app"

read -rp '现有网页 OAuth 客户端 ID: ' client_id
read -rp '允许连接的 Google 账号邮箱: ' owner_email
if [[ ! "$client_id" =~ ^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$ || ! "$owner_email" =~ ^[^[:space:]@,=]+@[^[:space:]@,=]+\.[^[:space:]@,=]+$ ]]; then
  echo '请检查 OAuth 客户端 ID 和邮箱。' >&2
  exit 1
fi

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com secretmanager.googleapis.com iam.googleapis.com drive.googleapis.com --project "$project"

if ! gcloud firestore databases describe --database='(default)' --project "$project" >/dev/null 2>&1; then
  gcloud firestore databases create --database='(default)' --location "$region" --type=firestore-native --project "$project"
fi
database_type=$(gcloud firestore databases describe --database='(default)' --project "$project" --format='value(type)')
if [[ "$database_type" != FIRESTORE_NATIVE ]]; then
  echo '授权服务需要 Firestore Native 数据库。' >&2
  exit 1
fi

for name in "$runtime_name" "$build_name"; do
  if ! gcloud iam service-accounts describe "$name@$project.iam.gserviceaccount.com" --project "$project" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$name" --project "$project"
  fi
done
gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:$runtime" --role=roles/datastore.user --condition=None --quiet >/dev/null
gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:$builder" --role=roles/run.builder --condition=None --quiet >/dev/null

oauth_secret=hiba-drive-oauth-client-secret
encryption_secret=hiba-drive-token-key
if ! gcloud secrets describe "$oauth_secret" --project "$project" >/dev/null 2>&1; then
  read -rsp '网页 OAuth 客户端密钥（输入时不显示）: ' client_secret
  printf '\n'
  if [[ -z "$client_secret" ]]; then exit 1; fi
  printf '%s' "$client_secret" | gcloud secrets create "$oauth_secret" --project "$project" --data-file=-
  unset client_secret
fi
if ! gcloud secrets describe "$encryption_secret" --project "$project" >/dev/null 2>&1; then
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets create "$encryption_secret" --project "$project" --data-file=-
fi
for name in "$oauth_secret" "$encryption_secret"; do
  gcloud secrets add-iam-policy-binding "$name" --project "$project" --member="serviceAccount:$runtime" \
    --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done
oauth_version=$(gcloud secrets versions list "$oauth_secret" --project "$project" --filter='state=ENABLED' --sort-by='~createTime' --limit=1 --format='value(name.basename())')
key_version=$(gcloud secrets versions list "$encryption_secret" --project "$project" --filter='state=ENABLED' --sort-by='~createTime' --limit=1 --format='value(name.basename())')
if [[ ! "$oauth_version" =~ ^[0-9]+$ || ! "$key_version" =~ ^[0-9]+$ ]]; then
  echo '授权服务需要已启用的 OAuth 和加密密钥版本。' >&2
  exit 1
fi
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)

gcloud run deploy "$service" --source "$source_dir" --project "$project" --region "$region" \
  --service-account "$runtime" --build-service-account "projects/$project/serviceAccounts/$builder" \
  --no-invoker-iam-check --min-instances=0 --max-instances=2 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$project,SERVICE_URL=$url,GOOGLE_CLIENT_ID=$client_id,GOOGLE_OWNER_EMAIL=$owner_email" \
  --set-secrets "GOOGLE_CLIENT_SECRET=$oauth_secret:$oauth_version,TOKEN_ENCRYPTION_KEY=$encryption_secret:$key_version" --quiet

curl --fail --silent --show-error --retry 3 "$url/health" >/dev/null
printf '\n授权服务地址\n%s\n\n在现有 OAuth 客户端添加的已获授权的重定向 URI\n%s/oauth/callback\n' "$url" "$url"
