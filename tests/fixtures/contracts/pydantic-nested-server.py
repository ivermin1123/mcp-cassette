from enum import Enum
from typing import Optional
from pydantic import BaseModel
from mcp.server.fastmcp import FastMCP

class Priority(str, Enum):
    low = "low"
    high = "high"

class Address(BaseModel):
    street: str
    city: str

class User(BaseModel):
    name: str
    address: Address                 # nested model
    backup: Optional[Address] = None # reused model
    priority: Priority = Priority.low

mcp = FastMCP("nested-probe")

@mcp.tool()
def create_user(user: User, note: str = "") -> str:
    """Create a user from a nested model."""
    return "ok"

if __name__ == "__main__":
    mcp.run()
