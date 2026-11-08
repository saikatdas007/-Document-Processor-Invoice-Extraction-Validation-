import psycopg2
import os
from dotenv import load_dotenv

load_dotenv()

# Get the URL from your .env
db_url = os.getenv("DATABASE_URL")

try:
    # Attempt a direct connection using the driver
    conn = psycopg2.connect(db_url)
    print("Connection Successful!")
    conn.close()
except Exception as e:
    print(f"Error connecting to PostgreSQL: {e}")