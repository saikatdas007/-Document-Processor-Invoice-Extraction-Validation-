from pymongo import MongoClient
from pymongo.errors import ServerSelectionTimeoutError

try:
    print("Attempting to connect to MongoDB...")
    # Set a short timeout (3 seconds) so it fails fast if offline
    client = MongoClient("mongodb://localhost:27017/", serverSelectionTimeoutMS=3000)
    
    # Ping the server to verify connection
    client.admin.command('ping')
    print("SUCCESS: Connected to MongoDB successfully!")
    
except ServerSelectionTimeoutError as err:
    print("\n--- MONGODB CONNECTION FAILED ---")
    print("Could not connect to MongoDB server on port 27017.")
    print(f"Details: {err}")
    print("\nTip: Make sure the MongoDB service is started on your computer.")
except Exception as err:
    print("\n--- UNEXPECTED ERROR ---")
    print(f"Details: {err}")