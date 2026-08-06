import os

DATABASE_URL = os.environ["DATABASE_URL"]

def sync_users():
	rows = fetch_all()
	return rows

def fetch_all():
	return []
