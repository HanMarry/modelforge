---
name: graph-and-network
description: Model a problem as a graph or network and solve it — shortest path, minimum spanning tree, maximum flow and min-cut, matching and assignment, connectivity and centrality, and TSP/routing heuristics. Use when entities have pairwise relations, when the task involves routes, allocation on a network, connecting nodes cheaply, or finding influential or critical nodes.
---

# Graph and Network Modelling

Use this skill when the problem is about **relations between entities**: routes, pipes,
supply chains, social or citation links, critical infrastructure. The deliverable is a
graph definition, the right algorithm with its complexity, and a validated solution.

## Requirements

```bash
uv pip install networkx numpy
uv pip install osmnx            # only when the graph comes from a real street network
```

`networkx` covers almost everything below. Reach for a MILP solver (see
`optimization-modeling`) when the problem has side constraints.

## Step 1 — Define the graph before choosing an algorithm

Decide and write down:

- **Nodes** — what each node represents, and the total count.
- **Edges** — directed or undirected? Do both directions have the same cost?
- **Weights** — distance, time, cost, or capacity? State the unit. If several weights
  matter, you have a multi-criteria problem, not a single-weight graph.
- **Connectedness** — check it. An unreachable target makes "no route" the correct
  answer, and an algorithm that silently returns a partial path is wrong.

```python
import networkx as nx
graph = nx.from_pandas_edgelist(edges, source="from", target="to", edge_attr="cost",
                                create_using=nx.DiGraph)
print(graph.number_of_nodes(), graph.number_of_edges(), nx.is_strongly_connected(graph))
```

The adjacency structure is a result in itself: report node and edge counts, degree
distribution, and whether the graph is connected or has isolated components.

## Step 2 — Match the question to the algorithm

| Question | Algorithm | Complexity note |
|---|---|---|
| cheapest route between two nodes | Dijkstra (`single_source_dijkstra_path`) | non-negative weights only |
| route with negative weights | Bellman–Ford | detects negative cycles |
| all-pairs cheapest routes | Floyd–Warshall or Johnson | pick by sparsity |
| connect all nodes at minimum cost | minimum spanning tree (Kruskal/Prim) | undirected only |
| maximum throughput with capacity limits | max flow (`maximum_flow`) | min-cut gives the bottleneck |
| assign n tasks to n agents | bipartite matching (`linear_sum_assignment`) | exact and fast |
| visit every node once, cheapest | TSP — **NP-hard** | use heuristics, report the gap |
| most influential / critical node | centrality measures | say which and why |
| cut the network into communities | Louvain / Girvan–Newman | report the modularity |

**Dijkstra requires non-negative weights.** A "cost saving" modelled as a negative edge
silently produces wrong paths. If you need negative weights, say so and use Bellman–Ford.

## Step 3 — TSP and routing: be honest about optimality

TSP is NP-hard. Options, in order of preference:

1. **Exact** for small instances — Held–Karp up to ~15–20 nodes, or a MILP formulation
   with subtour elimination. Report the proven optimum.
2. **Christofides / nearest-neighbour + 2-opt** for larger instances. Report the tour
   length and the **gap against a lower bound** (e.g. the 1-tree or the LP relaxation).
3. **Metaheuristic** (see `optimization-modeling`) — run 10+ seeds and report the
   distribution of tour lengths.

Never describe a nearest-neighbour tour as optimal. If a bound is unavailable, say
"best found" and give the time budget.

## Step 4 — Validate the solution on the graph, not the code

For any returned path or flow:

- Recompute the objective by walking the actual edges and summing the weights — do not
  trust the algorithm's reported total.
- Confirm the path is **connected** (each consecutive pair shares an edge) and that each
  edge exists in the graph.
- For flows, verify **capacity** on every edge and **conservation** at every intermediate
  node (inflow = outflow, except at source and sink).
- For matchings, verify no node is used twice.
- Recheck that constraints from the problem statement (time windows, vehicle count,
  banned edges) are satisfied by the returned solution.

## Step 5 — Interpret, don't just compute

A shortest path is rarely the answer to the modelling question. Also report:

- **which edges are critical**: recompute after removing the heaviest-used edge and
  report how much the objective degrades (this is the practical version of min-cut);
- **centrality** of the important nodes, with the measure named;
- **robustness**: how the solution changes if one node or edge fails;
- the **scaling** behaviour if the instance grows (this is often the paper's discussion
  section).

## Rules

- Never run Dijkstra on negative weights.
- Never report an exact optimum for a heuristic solution on an NP-hard instance.
- Never present a path without verifying it edge by edge.
- Never ignore a disconnected graph; state the components and their sizes.
- Never report a centrality ranking without naming the centrality measure used — they
  disagree, and the choice is a modelling decision.
- State the graph's size and the algorithm's complexity so the reader can judge whether
  the approach scales.
