# Group trust management service
1. Listens for CirclesBackingCompleted events (someone backed their Circles with a backing asset and created liquidity)
2. Checks if the backer is marked as bot
3. Calls `trustBatchWithConditions` on the managed group and adds trust relations to new backers

