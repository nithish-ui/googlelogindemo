import os
import json
import base64
import urllib.request
import urllib.parse
from datetime import datetime, timezone
import boto3
from botocore.exceptions import ClientError

DYNAMODB_TABLE = os.environ.get("DYNAMODB_TABLE", "GoogleLoginAppTable")
KMS_KEY_ID = os.environ.get("KMS_KEY_ID", "")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(DYNAMODB_TABLE)
kms_client = boto3.client("kms")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json"
}

def build_response(status_code: int, body: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body)
    }

def exchange_gcp_oauth_code(code: str, redirect_uri: str) -> dict:
    token_url = "https://oauth2.googleapis.com/token"
    token_data = urllib.parse.urlencode({
        "code": code,
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code"
    }).encode("utf-8")

    req = urllib.request.Request(
        token_url,
        data=token_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))

def get_gcp_userinfo(access_token: str) -> dict:
    userinfo_url = "https://www.googleapis.com/oauth2/v3/userinfo"
    req = urllib.request.Request(
        userinfo_url,
        headers={"Authorization": f"Bearer {access_token}"}
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))

def encrypt_token_with_kms(plaintext: str) -> str:
    if not KMS_KEY_ID:
        return base64.b64encode(plaintext.encode("utf-8")).decode("utf-8")
    response = kms_client.encrypt(
        KeyId=KMS_KEY_ID,
        Plaintext=plaintext.encode("utf-8")
    )
    return base64.b64encode(response["CiphertextBlob"]).decode("utf-8")

def decrypt_token_with_kms(ciphertext_b64: str) -> str:
    if not KMS_KEY_ID:
        try:
            return base64.b64decode(ciphertext_b64.encode("utf-8")).decode("utf-8")
        except Exception:
            return ciphertext_b64
    ciphertext_bytes = base64.b64decode(ciphertext_b64.encode("utf-8"))
    response = kms_client.decrypt(CiphertextBlob=ciphertext_bytes)
    return response["Plaintext"].decode("utf-8")

def lambda_handler(event, context):
    http_method = event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod", "")
    raw_path = event.get("rawPath") or event.get("path", "")

    if http_method == "OPTIONS":
        return build_response(200, {"message": "CORS preflight OK"})

    try:
        body = json.loads(event["body"]) if event.get("body") else {}

        # POST /auth/google: Exchanges GCP code, encrypts credentials via KMS, saves in DynamoDB
        if http_method == "POST" and "/auth/google" in raw_path:
            code = body.get("code")
            redirect_uri = body.get("redirect_uri", "")

            tokens = exchange_gcp_oauth_code(code, redirect_uri)
            access_token = tokens.get("access_token")
            user_info = get_gcp_userinfo(access_token)

            user_id = user_info.get("sub")
            email = user_info.get("email")

            # Encrypt GCP OAuth credentials with AWS KMS
            encrypted_access_token = encrypt_token_with_kms(access_token)

            item_id = f"INBOX#{int(datetime.now(timezone.utc).timestamp())}"
            table.put_item(
                Item={
                    "userId": user_id,
                    "itemId": item_id,
                    "title": "GCP Google OAuth 2.0 Access Token",
                    "sender": "GCP OAuth 2.0 Authorization Server",
                    "ciphertextBlob": encrypted_access_token,
                    "status": "Encrypted with AWS KMS",
                    "email": email,
                    "createdAt": datetime.now(timezone.utc).isoformat()
                }
            )

            return build_response(200, {
                "status": "success",
                "user": {"sub": user_id, "email": email, "name": user_info.get("name", email), "picture": user_info.get("picture", "")},
                "session_token": f"GCP_SESSION_{user_id}_{int(datetime.now(timezone.utc).timestamp())}"
            })

        # GET /inbox: Reads encrypted DynamoDB items and decrypts them via KMS
        elif http_method == "GET" and "/inbox" in raw_path:
            user_id = (event.get("queryStringParameters") or {}).get("userId")
            resp = table.query(
                KeyConditionExpression=boto3.dynamodb.conditions.Key("userId").eq(user_id),
                ScanIndexForward=False
            )
            items = []
            for item in resp.get("Items", []):
                ciphertext = item.get("ciphertextBlob")
                items.append({
                    "itemId": item.get("itemId"),
                    "title": item.get("title"),
                    "sender": item.get("sender"),
                    "status": item.get("status"),
                    "createdAt": item.get("createdAt"),
                    "ciphertextBlob": ciphertext,
                    "decryptedToken": decrypt_token_with_kms(ciphertext) if ciphertext else None
                })
            return build_response(200, {"status": "success", "items": items})

        # POST /inbox: Encrypts arbitrary token/credential via KMS into DynamoDB
        elif http_method == "POST" and "/inbox" in raw_path:
            user_id = body.get("userId")
            ciphertext = encrypt_token_with_kms(body.get("credentialToken"))
            item_id = f"INBOX#{int(datetime.now(timezone.utc).timestamp())}"
            table.put_item(
                Item={
                    "userId": user_id,
                    "itemId": item_id,
                    "title": body.get("title", "Encrypted Item"),
                    "sender": body.get("sender", "Service"),
                    "ciphertextBlob": ciphertext,
                    "status": "KMS Encrypted",
                    "createdAt": datetime.now(timezone.utc).isoformat()
                }
            )
            return build_response(201, {"status": "success", "itemId": item_id})

        return build_response(404, {"error": "Not Found"})
    except Exception as e:
        return build_response(500, {"error": str(e)})